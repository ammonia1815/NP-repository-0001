import { loadConfig } from "./config";
import { Assistant, AssistantImage, AssistantReply, AssistantStateHint, ConversationSession, REPLY_SCHEMA } from "./assistant-types";
import { buildContextPrefix } from "./memory";
import { TurnSource } from "./state";
import { webSearch, formatSearchResultsForModel, fetchPageText, WebSearchResult } from "./localSearch";
import { extractYoutubeVideoId, fetchYoutubeInfo, formatYoutubeInfoForModel } from "./localYoutube";
import { recallOriginalConversation, MemoryCandidate } from "./longterm";

// Ollama's own default local server address - never exposed outside this
// machine, so no auth/token needed the way the real APIs require.
const OLLAMA_URL = "http://localhost:11434";

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  message?: OllamaMessage;
}

// Confirmed against the real API: Ollama's `format` (strict JSON schema
// output) and `tools` (function calling) don't work together on this model -
// combined, the model always just satisfies the JSON shape directly and
// never emits a tool_calls entry, even with an explicit "always call the
// tool" instruction; tools alone work immediately and correctly. So this
// provider runs two separate phases: an untyped tool-calling loop first,
// then one final format-constrained call (mirroring the extra "follow-up
// call" gemini.ts/claude.ts already do after their own tool rounds) to shape
// the actual reply.
const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "웹을 검색합니다. 실시간 정보나 확실하지 않은 사실을 확인해야 할 때 사용하세요.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "검색어" } },
      required: ["query"],
    },
  },
};

// Deliberately selects by INDEX into the most recent web_search call's own
// results, never by a model-supplied URL - same reasoning as
// RECALL_YOUTUBE_TOOL below: a free-text url parameter is the thing that
// breaks, an index into something the model just actually saw is safe.
// Exists because a search result's snippet is sometimes too shallow to
// contain the real answer - confirmed for real that a specific fact sat deep
// inside a long wiki article's body, far beyond what any snippet could ever
// capture, even though the correct page showed up in the result list.
const READ_RESULT_TOOL = {
  type: "function" as const,
  function: {
    name: "read_search_result",
    description:
      "방금 web_search로 찾은 결과 중 스니펫만으론 답을 찾기 부족할 때, 가장 관련성 높아 보이는 결과의 번호를 골라 그 페이지 본문을 더 자세히 읽습니다. web_search를 먼저 호출한 뒤에만 사용할 수 있습니다.",
    parameters: {
      type: "object",
      properties: { index: { type: "integer", description: "web_search 결과 목록에서의 번호 (1부터 시작)" } },
      required: ["index"],
    },
  },
};

// Wiki domains get their matching section fetched automatically by
// executeSearch below, with no model decision involved - the user flagged
// that leaving "should I read the full page?" to the model's own judgment
// (via READ_RESULT_TOOL) was an extra unreliable step for exactly the common
// case of a plain, wiki-documented fact. Confirmed in this session that a
// snippet alone regularly isn't enough for these sites specifically, so
// there's no real downside to just always fetching when one of these shows
// up near the top of the results - it costs one extra request to the TARGET
// site, separate from the search request itself.
const AUTO_FETCH_DOMAINS = ["namu.wiki", "wikipedia.org"];

function isAutoFetchDomain(link: string): boolean {
  try {
    const host = new URL(link).hostname;
    return AUTO_FETCH_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// Deliberately NO parameters - see the long comment above findYoutubeUrlInRecentTurns
// for why a url: string slot is the exact thing that made the model fabricate
// links. This tool only tells the code WHEN to look (the model's call to make,
// since it alone knows whether the current message is actually a follow-up
// about a previously-mentioned video), never WHICH url (the code's job).
const RECALL_YOUTUBE_TOOL = {
  type: "function" as const,
  function: {
    name: "recall_youtube_video",
    description:
      "사용자가 몇 턴 전에 공유했던 유튜브 영상에 대해 이어서 질문하는데, 이번 메시지 자체에는 링크가 없는 경우에만 호출하세요 (예: '그 영상 내용 다시 알려줘', '아까 그거 몇 분짜리야'). 현재 메시지에 직접 링크가 있으면 이미 자동으로 정보가 제공되니 호출할 필요 없습니다. 영상과 무관한 질문(예: 점심 메뉴 추천, 날씨, 다른 주제 등)에는 절대로 호출하지 마세요 - 애매하면 호출하지 않는 쪽을 택하세요. 파라미터는 없습니다 - 최근 대화에서 가장 마지막으로 공유된 링크를 시스템이 알아서 찾습니다.",
    parameters: { type: "object", properties: {} },
  },
};

// Same index-only shape as READ_RESULT_TOOL and for the same reason - the
// model picks WHICH numbered item from "[예전 대화에서 기억하는 내용]" it wants
// to dig into, never a free-text id/timestamp it could fabricate, and the
// code resolves that index to a real entry.
const RECALL_MEMORY_TOOL = {
  type: "function" as const,
  function: {
    name: "recall_original_conversation",
    description:
      "[예전 대화에서 기억하는 내용] 블록에 뜬 요약 기억 중 하나가 너무 짧게 요약되어 있어서 더 자세한 원본 대화가 필요할 때, 그 번호를 골라 원본 대화 전후 턴을 직접 확인합니다. 모든 기억에 다 쓸 필요는 없고, 사용자가 그 기억에 대해 더 자세히 물어보거나 디테일이 중요한 경우에만 사용하세요.",
    parameters: {
      type: "object",
      properties: { index: { type: "integer", description: "[예전 대화에서 기억하는 내용] 목록에서의 번호 (1부터 시작)" } },
      required: ["index"],
    },
  },
};

const ALL_TOOLS = [SEARCH_TOOL, READ_RESULT_TOOL, RECALL_YOUTUBE_TOOL, RECALL_MEMORY_TOOL];

// Raised from 3 to 4 now that a thorough answer can take search -> read a
// result's full page -> read a second candidate page -> finalize.
const MAX_TOOL_ITERATIONS = 4;

// YouTube info is deliberately NOT a tool the model calls with a free-text
// URL parameter - it was, and that was the problem. Confirmed for real, in
// two different failure shapes, that giving the model a url: string slot to
// fill is itself the vulnerability, not just a prompting gap:
//   1. Before any YouTube handling existed: shown a link about an unrelated
//      boss ("바느질왕"), it confidently wrote up a *different* boss fight
//      ("붉은 신") that was a recent memory-context topic instead - never saw
//      the video, pattern-matched the topic and presented the guess as fact.
//   2. After a get_youtube_info(url) tool was added: asked to "다시 확인해줘"
//      (re-check) a link from over an hour earlier with no URL in the
//      current message, it called the tool with a fabricated placeholder
//      ("YOUR_VIDEO_") - the fetch failed on every front as a result.
//   3. After adding an explicit "never fabricate a URL, ask instead"
//      instruction for exactly that: in a context with literally no video
//      ever mentioned, it fabricated a *real, famous* video instead
//      (Rick Astley's "Never Gonna Give You Up") and the tool happily
//      fetched real info about that correct-but-irrelevant video - the
//      instruction only blocked obviously-fake placeholders, not a model
//      that reaches for a plausible real example when it wants to comply.
// No prompt wording closed all three, because the model always had a text
// field it could fill with *something*. Removing that field is what
// actually fixes it: the current message's own link is extracted directly
// in send() below (unconditional, no ambiguity about intent), and a link
// from EARLIER turns is only ever looked up through RECALL_YOUTUBE_TOOL -
// a zero-argument tool call, so the model decides WHEN (a judgment call it's
// fine at) but never WHICH url (the part that broke).
//
// An earlier version of this fix auto-injected an older link into every
// message within a fixed lookback window, with no regard for whether the new
// message was actually about the video. That caused a different real
// regression: right after asking about a video, asking about something else
// entirely on the very next turn still dragged the old video's info back
// into context every time within the window, crowding out the actual recent
// conversation (confirmed by the user noticing both slower replies and worse
// recent-context awareness). The tool-call design fixes this because the
// model simply won't call recall_youtube_video when the new message isn't
// about the video - no window size can distinguish "still talking about the
// video" from "moved on" the way the model's own read of the message can.
const YOUTUBE_LOOKBACK_TURNS = 10;

function findYoutubeUrlInRecentTurns(sessionTurns: ConversationSession["turns"]): string | null {
  const recentTurns = sessionTurns.slice(-YOUTUBE_LOOKBACK_TURNS);
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const found = extractYoutubeVideoId(recentTurns[i].text);
    if (found) return found;
  }
  return null;
}

async function fetchYoutubeBlockFor(videoId: string): Promise<string> {
  try {
    const info = await fetchYoutubeInfo(videoId);
    return `[유튜브 영상 정보]\n${formatYoutubeInfoForModel(info)}`;
  } catch (err) {
    console.error("YouTube info fetch failed:", err);
    return "[유튜브 영상 정보]\n(정보를 가져오지 못했습니다.)";
  }
}

// The model sometimes produces a FINAL reply that only promises future
// action ("검색해보겠습니다", "확인해보겠습니다") instead of either
// answering or admitting it doesn't know - confirmed for real in production
// use, and the user specifically flagged that persona-prompt wording alone
// ("미루지 말고 답하라") was unlikely to fix this reliably. They're right:
// this isn't a persona problem, it's architectural. Phase 2 (the
// format-constrained call below) IS the end of this turn - there is no
// later point where the model gets to act on a promise it makes here, so a
// "I'll check" reply just leaves the user stuck with nothing. Matched only
// against a SHORT reply (not a reply that gives a real answer and merely
// offers to verify further afterward) to avoid flagging legitimate complete
// answers that happen to end with a soft follow-up offer.
// A plain substring list proved too brittle against real Korean conjugation
// variants (confirmed against actual transcript lines: "조회해 보겠습니다"
// and "검색하여 확인하겠습니다" both slipped past an earlier version of this
// that only listed exact phrases like "확인해보겠습니다"). This instead
// matches a verification-verb stem followed within a few characters by the
// "겠" future-intention ending, which catches the conjugation variants
// without needing to enumerate every one.
const DEFERRAL_PATTERN = /(검색|확인|조회|찾아|조사|알아보|살펴보|분석|파악|점검).{0,5}겠(습니다|어요|네요)/;
const DEFERRAL_REPLY_MAX_LENGTH = 80;

function isDeferralReply(reply: string): boolean {
  return reply.length <= DEFERRAL_REPLY_MAX_LENGTH && DEFERRAL_PATTERN.test(reply);
}

const LOCAL_LIMITATIONS =
  "\n\n[이 세션 전용 중요 제약사항] 유튜브 영상 정보는 메시지에 링크가 직접 있을 때만 시스템이 자동으로 [유튜브 영상 정보] 블록으로 붙여줍니다. 링크 없이 '아까 그 영상' 식으로 명확히 그 영상 내용을 이어서 물어볼 때만 recall_youtube_video 도구를 호출하세요 (파라미터 없음, 최근 대화에서 시스템이 알아서 찾습니다) - 영상과 무관한 새 주제(점심 메뉴, 날씨, 다른 질문 등)로 넘어갔다면 절대 호출하지 말고 그냥 그 주제에 바로 답하세요. 그 도구가 못 찾았다고 답하면 추측하지 말고 \"그 링크를 다시 보내주시겠어요?\"라고 솔직하게 요청하세요. 이 정보는 영상을 실제로 보거나 듣는 게 아니라 텍스트(자막 등)만 읽은 것이니, 자막/설명이 부실하면 내용 파악이 어렵다고 솔직히 답하세요. 유튜브가 아닌 다른 URL(일반 웹페이지 등)은 열어볼 수 있는 도구가 없으니, 링크가 뭔지 모르면 \"그 링크 내용은 직접 볼 수 없으니 어떤 내용인지 설명해 주시겠어요?\"라고 솔직하게 물어보세요. web_search 결과의 요약(스니펫)만으론 구체적인 사실(예: 특정 설정, 상세 수치)을 확인하기 부족하면, 추측하지 말고 read_search_result로 가장 관련성 높은 결과 번호를 선택해 본문을 직접 확인한 뒤 답하세요. 게임/작품의 구체적인 설정, 줄거리, 엔딩, 수치처럼 외워서 틀리기 쉬운 사실을 물으면, 확신이 들더라도 먼저 web_search로 검증한 뒤 답하세요 - 검증 없이 바로 답했다가 틀리는 것이 가장 큰 문제입니다. 이런 종류의 질문에 대해 [지금 세션의 최근 대화] 블록에 너 자신이 예전에 답했던 내용이 이미 있더라도, 그걸 검증된 사실로 여기고 그대로 재사용하지 마세요 - 그 예전 답변 자체가 검증 없이 틀렸던 답변일 수 있습니다. 같은 주제를 다시 묻거나 더 파고드는 질문을 받으면, 이전 답변을 그냥 베끼지 말고 매번 새로 web_search를 호출해서 다시 확인한 뒤 답하세요. 그리고 web_search 결과가 \"검색 결과가 없습니다\"로 오거나 도구 호출이 실패하면, 그 즉시 너의 기존 지식으로 구체적인 답을 지어내지 말고 \"검색이 되지 않아서 확인하지 못했습니다\"라고 있는 그대로 말하세요 - 검색이 실패했다는 사실 자체를 숨기고 그럴듯한 답을 만들어내는 것이 가장 나쁜 행동입니다. web_search나 read_search_result가 결과를 정상적으로 반환했을 때도 마찬가지로 조심하세요 - 그 결과에 실제로 적힌 이름·사실만 답에 사용하고, 검색 결과 어디에도 등장하지 않는 인물명이나 설정을 그럴듯하게 새로 지어내지 마세요. 결과를 다 읽어도 질문에 대한 명확한 답을 찾지 못했다면, 비슷해 보이는 다른 이름으로 추측해서 채우지 말고 \"검색 결과에서 정확히 확인하지 못했습니다\"라고 솔직히 말하세요 - 검색 결과를 받고도 그 안에 없는 내용을 지어내는 것은 아예 검색하지 않고 답하는 것보다 더 나쁜 행동입니다. [예전 대화에서 기억하는 내용] 블록의 항목들은 AI가 요약·압축한 것이라 디테일이 생략되어 있을 수 있습니다 - 사용자가 그 기억에 대해 구체적으로 더 캐묻는데 요약만으론 부족하면, 추측하지 말고 recall_original_conversation으로 번호를 골라 원본 대화를 직접 확인하세요. 그 도구가 \"확인하지 못했습니다\"라고 답하면 그 사실을 그대로 솔직히 전달하세요.";

export class LocalAssistant implements Assistant {
  private config = loadConfig();

  // Always "ready" in the sense of being configured - unlike Gemini/Claude
  // there's no API key to check locally; if Ollama itself isn't running, a
  // real send() attempt below fails with a clear, catchable error instead.
  isReady(): boolean {
    return true;
  }

  // withTools/withFormat are mutually exclusive on this model - see the
  // SEARCH_TOOL comment above. Never pass both true.
  private async callModel(
    messages: OllamaMessage[],
    opts: { withTools: boolean; withFormat: boolean }
  ): Promise<OllamaChatResponse> {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.localModel,
        messages,
        think: false,
        ...(opts.withTools ? { tools: ALL_TOOLS } : {}),
        ...(opts.withFormat ? { format: REPLY_SCHEMA } : {}),
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<OllamaChatResponse>;
  }

  // Populated by executeSearch, read by executeReadResult - lets
  // read_search_result's index refer to "whatever web_search just returned"
  // without the model needing to repeat a URL itself. Reset per send() call
  // (see the fresh object created in send() below), so it never leaks a
  // stale result list across unrelated conversations.
  private async executeSearch(args: Record<string, unknown>, searchState: { query: string | null; results: WebSearchResult[] }): Promise<string> {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query) return "검색어가 비어 있습니다.";
    try {
      const results = await webSearch(query);
      // Mirrors gemini.ts's own "[perf] web search used" logging - this path
      // had none before, which is exactly why a real incident (search coming
      // back empty, model answering confidently anyway) couldn't be
      // diagnosed from electron.log afterward and had to be guessed at.
      console.log(`[local-search] query="${query}" -> ${results.length}건`);
      searchState.query = query;
      searchState.results = results;
      let formatted = formatSearchResultsForModel(results);

      // Fetches up to 2 wiki-domain results, not just the first one -
      // confirmed for real that a search engine's own ranking can put a
      // less-relevant wiki page first (a chapter's combat-mechanics page
      // ranked above its story page, when the question was about an ending),
      // so committing
      // to a single "first wiki hit" guess is itself unreliable. Giving the
      // model both candidates' real sections costs one extra page fetch but
      // removes that ranking-order gamble.
      const wikiResults = results.filter((r) => isAutoFetchDomain(r.link)).slice(0, 2);
      for (const wikiResult of wikiResults) {
        try {
          const pageText = await fetchPageText(wikiResult.link, query);
          console.log(`[local-search] 위키 문서 자동 확인: "${wikiResult.title}"`);
          formatted += `\n\n[참고: "${wikiResult.title}" 문서 본문 자동 확인]\n${pageText}`;
        } catch (err) {
          console.error("Auto wiki fetch failed:", err);
        }
      }

      return formatted;
    } catch (err) {
      console.error("Web search failed:", err);
      return "검색 중 오류가 발생했습니다.";
    }
  }

  private async executeReadResult(args: Record<string, unknown>, searchState: { query: string | null; results: WebSearchResult[] }): Promise<string> {
    const index = typeof args.index === "number" ? args.index : -1;
    const result = searchState.results[index - 1];
    if (!result) return "web_search를 먼저 호출해서 유효한 결과 번호를 확인한 뒤 다시 시도하세요.";
    try {
      const text = await fetchPageText(result.link, searchState.query ?? undefined);
      return `[${result.title}] 페이지 본문:\n${text}`;
    } catch (err) {
      console.error("Page fetch failed:", err);
      return "페이지 내용을 가져오지 못했습니다.";
    }
  }

  private async executeRecallYoutube(sessionTurns: ConversationSession["turns"]): Promise<string> {
    const videoId = findYoutubeUrlInRecentTurns(sessionTurns);
    if (!videoId) return "최근 대화에서 유튜브 링크를 찾지 못했습니다.";
    return fetchYoutubeBlockFor(videoId);
  }

  private executeRecallMemory(args: Record<string, unknown>, memoryCandidates: MemoryCandidate[]): string {
    const index = typeof args.index === "number" ? args.index : -1;
    const candidate = memoryCandidates[index - 1];
    if (!candidate) return "해당 번호의 기억을 찾을 수 없습니다. [예전 대화에서 기억하는 내용] 목록의 번호를 다시 확인하세요.";
    if (!candidate.id) return "이건 요약된 기억이 아니라 최근 대화 원문이라, 더 불러올 원본이 따로 없습니다.";
    return recallOriginalConversation(candidate.id);
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    sessionTurns: ConversationSession["turns"],
    searchState: { query: string | null; results: WebSearchResult[] },
    memoryCandidates: MemoryCandidate[]
  ): Promise<string> {
    if (name === "web_search") return this.executeSearch(args, searchState);
    if (name === "read_search_result") return this.executeReadResult(args, searchState);
    if (name === "recall_youtube_video") return this.executeRecallYoutube(sessionTurns);
    if (name === "recall_original_conversation") return this.executeRecallMemory(args, memoryCandidates);
    return "알 수 없는 도구입니다.";
  }

  private async runFinalFormatCall(messages: OllamaMessage[]): Promise<AssistantReply | null> {
    const final = await this.callModel(messages, { withTools: false, withFormat: true });
    const raw = final.message?.content ?? "{}";
    try {
      return JSON.parse(raw) as AssistantReply;
    } catch (err) {
      console.error("Local model's final reply wasn't valid JSON:", raw, err);
      return null;
    }
  }

  async send(
    userText: string,
    session: ConversationSession,
    idleGapMs: number,
    source: TurnSource,
    images?: AssistantImage[],
    onStateHint?: (state: AssistantStateHint) => void
  ): Promise<AssistantReply> {
    const { prefix, memoryCandidates } = await buildContextPrefix(userText, session.turns, session.startedAt, idleGapMs, source, "local");

    // Only the CURRENT message's own link is auto-injected - unconditional,
    // since a link the user just pasted is unambiguously meant to be looked
    // at. A link from earlier turns is deliberately NOT auto-injected here;
    // that's RECALL_YOUTUBE_TOOL's job below, decided by the model's own
    // read of whether this message is actually a follow-up about it.
    const directVideoId = extractYoutubeVideoId(userText);
    const youtubeBlock = directVideoId ? `\n\n${await fetchYoutubeBlockFor(directVideoId)}` : "";

    const content = (prefix ? `${prefix}\n\n[새 메시지]\n${userText}` : userText) + youtubeBlock;
    session.turns.push({ role: "user", text: userText, timestamp: Date.now() });

    try {
      // Ollama takes images as a bare array of base64 strings on the message
      // (no media-type wrapper the way Gemini/Claude's image blocks need) -
      // confirmed against the real model with an actual screen capture.
      const imageData = images && images.length > 0 ? images.map((img) => img.data) : undefined;
      const messages: Array<OllamaMessage & { images?: string[] }> = [
        { role: "system", content: this.config.systemPrompt + LOCAL_LIMITATIONS },
        { role: "user", content, images: imageData },
      ];

      // Phase 1: let the model call web_search/read_search_result/
      // recall_youtube_video zero or more times, with no format constraint
      // (confirmed necessary - see SEARCH_TOOL comment).
      const searchState: { query: string | null; results: WebSearchResult[] } = { query: null, results: [] };
      let iterations = 0;
      while (iterations < MAX_TOOL_ITERATIONS) {
        const result = await this.callModel(messages, { withTools: true, withFormat: false });
        const toolCalls = result.message?.tool_calls;
        if (!toolCalls || toolCalls.length === 0) break;
        iterations++;

        // Fired per real tool call, same as Gemini's own onStateHint("searching")
        // - the local path now routinely takes multi-second-to-multi-minute
        // round trips through Perplexity + wiki page fetches (confirmed for
        // real this session), so the avatar staying on its generic "thinking"
        // clip the whole time is no longer an accurate read of what's
        // happening, the way it was back when this tool loop was rare/fast.
        onStateHint?.("searching");
        messages.push({ role: "assistant", content: result.message?.content ?? "", tool_calls: toolCalls });
        for (const call of toolCalls) {
          const resultText = await this.executeTool(call.function.name, call.function.arguments, session.turns, searchState, memoryCandidates);
          messages.push({ role: "tool", content: resultText });
        }
      }

      // Phase 2: one final call, format-constrained, no tools - produces the
      // actual {reply, emotion} shape from whatever phase 1 gathered.
      let parsed = await this.runFinalFormatCall(messages);

      // A reply that only promises future action has nowhere to go in this
      // architecture - see DEFERRAL_PATTERNS' own comment. One retry, with
      // an explicit "this is your only chance" nudge, mirrors how
      // gemini.ts retries a blank reply instead of trusting prompt wording
      // alone to prevent a known bad pattern. If this turn never actually
      // called a tool yet (iterations === 0), the retry also gives it one
      // real chance to call one - genuinely acting on its own stated
      // intention - rather than only re-asking it to stop stalling with
      // nothing new to answer from.
      if (parsed?.reply && isDeferralReply(parsed.reply)) {
        console.log(`[local-deferral] detected stalling reply, retrying once: "${parsed.reply}"`);
        if (iterations === 0) {
          const retryResult = await this.callModel(messages, { withTools: true, withFormat: false });
          const retryToolCalls = retryResult.message?.tool_calls;
          if (retryToolCalls && retryToolCalls.length > 0) {
            messages.push({ role: "assistant", content: retryResult.message?.content ?? "", tool_calls: retryToolCalls });
            for (const call of retryToolCalls) {
              const resultText = await this.executeTool(call.function.name, call.function.arguments, session.turns, searchState, memoryCandidates);
              messages.push({ role: "tool", content: resultText });
            }
          }
        } else {
          messages.push({
            role: "user",
            content:
              "(시스템) 방금 답변이 '검색해보겠다/확인하겠다'처럼 미루는 내용이었습니다. 이건 이 대화의 마지막 기회이니, 이미 가진 검색 결과를 바탕으로 최종 답을 내놓거나, 정말 모르면 모른다고 솔직히 답하세요. 다시 미루는 답은 허용되지 않습니다.",
          });
        }
        parsed = await this.runFinalFormatCall(messages);
      }

      // Matches the same empty/malformed-reply guard gemini.ts and claude.ts
      // both have - a blank or unparseable reply would otherwise silently
      // pass through as a "successful" turn.
      if (!parsed?.reply) {
        console.error("Local model returned an empty/malformed reply after retry");
        return { reply: "미안해요, 지금 대답하는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.", emotion: "sad" };
      }

      session.turns.push({ role: "assistant", text: parsed.reply, timestamp: Date.now() });
      return parsed;
    } catch (err) {
      console.error("Local model error:", err);
      return {
        reply: "로컬 모델에 연결하지 못했어요. Ollama가 켜져 있는지 확인해주세요.",
        emotion: "sad",
      };
    }
  }
}
