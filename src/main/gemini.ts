import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "./config";
import { Assistant, AssistantImage, AssistantReply, AssistantStateHint, ConversationSession, REPLY_SCHEMA } from "./assistant-types";
import { buildContextPrefix } from "./memory";
import { TurnSource } from "./state";
import { recordGeminiUsage } from "./costTracking";
import { listFiles, readFileSafe, readFilesSafe, writeRecordFile } from "./files";
import { fetchPageText } from "./localSearch";
import {
  addRotationRule,
  appendHealthLog,
  correctPastShift,
  deleteHealthLog,
  queryHealthLogs,
  setShiftOverride,
  setShiftOverrideRange,
  updateHealthLog,
  updateTargets,
} from "./health";
import { recallOriginalConversation, MemoryCandidate } from "./longterm";
import { getActiveGeminiKey, hasGeminiKey, getKeyVersion, getKeyStatus, rotateToNextGeminiKey, isQuotaExceededError, AUTO_ROTATE_ON_QUOTA } from "./geminiKeys";

// ============================================================================
// Architecture note (confirmed for real this session, not guessed):
//
// Previously this file used the Interactions API (client.interactions.create),
// which streams a literal "google_search_call" step the instant a real web
// search starts - the only reason the avatar could ever show a distinct
// "searching" animation instead of generic "thinking". But the Interactions
// API explicitly does NOT support explicit (guaranteed) prompt caching - only
// probabilistic "implicit" caching, measured for real at a 12% hit rate
// across 200 real calls. Since the static system_instruction+tools prefix is
// ~56% of every call's input tokens, that meant paying for it in full on ~88%
// of calls.
//
// generateContent (the older, still-supported API) DOES support explicit
// caching (client.caches.create -> cachedContent), confirmed for real to
// reliably discount the cached portion every time. But it does NOT expose any
// mid-stream signal for Gemini's own built-in google_search tool - confirmed
// for real that the search completes entirely server-side BEFORE the first
// byte of any kind (even a "thought" chunk) reaches the client, so there is
// no way to show a "searching" animation during the real wait no matter what
// streaming/thinking config is used.
//
// The fix that keeps all three things the user needs: this file now uses
// generateContent with explicit caching for the persona+tools (call "A"), and
// REPLACES Gemini's opaque built-in google_search with our OWN plain
// function-declared `web_search` tool. A real function-call part streams back
// immediately (confirmed ~2.6s in, vs ~90ms of lead time for the built-in
// tool) - visible in plenty of time to drive the "searching" animation.
// Executing that tool makes a SEPARATE, uncached, lightweight generateContent
// call (call "B") that itself uses Gemini's real google_search tool - so the
// actual search still comes from Google's own index and still draws from the
// same monthly free-query allowance, just routed through a second call
// instead of inline. Confirmed for real (with usage numbers) that this nets
// OUT CHEAPER overall than the old no-caching approach, despite the extra
// call, because the caching discount on the repeated persona dwarfs call B's
// own (persona-free, so already cheap) cost.
// ============================================================================

const CACHE_TTL_SECONDS = 3600;
// Below this, Gemini rejects cache creation outright ("Cached content is too
// small") - confirmed for real (threshold varies by model generation; this
// is comfortably under every variant seen). Our real persona+tools content is
// ~5,600 tokens, far above it - this constant exists only as a readable
// landmark in the comments, not as a runtime check.
const MODEL = () => loadConfig().geminiModel;

// name/description/parameters only - NOT the `type: "function"` wrapper the
// old Interactions-API tool shape used. Confirmed for real that
// generateContent's functionDeclarations reject that extra field being
// present is NOT required (lowercase OpenAPI-style "object"/"string" schema
// types work fine, confirmed for real), but the declarations must be bare
// {name, description, parameters} objects.
interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

const WEB_SEARCH_TOOL: FunctionDeclaration = {
  name: "web_search",
  description: "웹을 검색합니다. 실시간 정보나 확실하지 않은 사실을 확인해야 할 때 사용하세요.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "검색어" } },
    required: ["query"],
  },
};

const FILE_TOOLS: FunctionDeclaration[] = [
  {
    name: "list_files",
    description:
      "허용된 조회 폴더('엔피 조회 가능 자료') 안의 파일/폴더 목록을 봅니다. path를 생략하면 최상위 폴더를 봅니다. 이 폴더 밖은 절대 볼 수 없습니다. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "조회할 하위 경로 (생략 시 최상위 폴더)" } },
    },
  },
  {
    name: "read_file",
    description:
      "허용된 조회 폴더 안의 파일 하나를 읽습니다. 텍스트 파일은 내용을 그대로, 이미지 파일은 이미지를 직접 봅니다. 읽기 전용이며 파일을 만들거나 수정, 삭제하는 기능은 없습니다. 파일을 2개 이상 읽어야 한다면 이걸 여러 번 부르지 말고 read_files를 한 번만 사용하세요. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "읽을 파일의 경로 (조회 폴더 기준 상대경로)" } },
      required: ["path"],
    },
  },
  {
    name: "read_files",
    description:
      "허용된 조회 폴더 안의 여러 파일(예: 사진 여러 장)을 한 번에 읽습니다. 사진 여러 장을 한꺼번에 분석해야 할 때처럼, 파일을 2개 이상 읽어야 하면 read_file을 반복 호출하지 말고 이걸 한 번만 사용하세요 - 매번 따로 부르면 그만큼 응답이 느려집니다. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "읽을 파일들의 경로 목록 (조회 폴더 기준 상대경로)" },
      },
      required: ["paths"],
    },
  },
  {
    name: "write_record_file",
    description:
      "조회 폴더 안의 '엔피_기록.md' 파일 하나에만 내용을 기록합니다. 다른 어떤 파일에도 쓸 수 없습니다. 사용자가 중요한 대화 내용·일정·코드 등을 '기록해줘/적어줘'처럼 명시적으로 요청했을 때만 호출하세요 - 애매하거나 요청하지 않았으면 절대 호출하지 마세요. '주인_메모.md'는 사용자가 직접 작성하는 별도 파일이라 이 도구로 절대 건드릴 수 없습니다(그 파일은 read_file로 읽기만 가능).",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "기록할 내용" },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description: "append=기존 기록 뒤에 이어서 추가(기본값, 보통 이걸 사용), overwrite=파일 전체를 이 내용으로 교체(사용자가 명확히 '전부 지우고 다시' 같은 요청을 했을 때만)",
        },
      },
      required: ["content"],
    },
  },
];

const HEALTH_TOOLS: FunctionDeclaration[] = [
  {
    name: "register_shift_rule",
    description:
      "사용자의 교대근무 로테이션 규칙을 새로 등록합니다. 기존에 진행 중이던 규칙은 자동으로 이 규칙 시작일 전날까지로 마감됩니다. 근무 패턴 자체가 바뀔 때(대략 3개월에 한 번 정도) 사용하세요 - 하루 대근/휴가는 register_shift_rule이 아니라 set_shift_override를 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "근무 코드 반복 패턴, 예: NNNXXDDXAAAX (N=야간,D=주간,A=오후,X=휴무)" },
        anchor_date: { type: "string", description: "패턴의 첫 글자가 적용되는 기준일, YYYY-MM-DD" },
        effective_from: { type: "string", description: "이 규칙이 적용되기 시작하는 날짜, YYYY-MM-DD (과거로 소급하지 말 것)" },
      },
      required: ["pattern", "anchor_date", "effective_from"],
    },
  },
  {
    name: "set_shift_override",
    description: "특정 날짜 하루의 근무를 대근/휴가 등으로 규칙과 다르게 예외 처리합니다. 이틀 이상 연속된 기간이면 이것을 여러 번 부르지 말고 set_shift_override_range를 한 번만 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        code: { type: "string", description: "실제 적용된 근무 코드, 예: DA" },
        reason: { type: "string", description: "사유, 예: 대근" },
      },
      required: ["date", "code"],
    },
  },
  {
    name: "set_shift_override_range",
    description: "여러 날짜에 걸친 연속된 기간(예: 여행/장기 휴가) 전체를 같은 코드로 한 번에 예외 처리합니다. 하루짜리면 set_shift_override를 대신 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD (포함)" },
        code: { type: "string", description: "이 기간 전체에 적용할 근무 코드, 예: X" },
        reason: { type: "string", description: "사유, 예: 휴가" },
      },
      required: ["start_date", "end_date", "code"],
    },
  },
  {
    name: "correct_past_shift",
    description: "이미 확정된 과거 날짜의 근무 기록을 뒤늦게 정정합니다 (근무 규칙 자체는 건드리지 않음).",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD, 오늘 또는 과거 날짜만 가능" }, code: { type: "string" } },
      required: ["date", "code"],
    },
  },
  {
    name: "log_health_entry",
    description:
      "사용자가 언급한 식사/음주/수면/운동을 새로 기록하거나, 기존 기록 하나를 수정합니다. timestamp를 비우면 새 기록을 생성하고, timestamp를 채우면 해당 id의 기존 기록을 수정합니다(채운 필드만 바뀌고 나머지는 그대로 유지됨). 수정 시 정확한 id가 필요하므로, 이번 대화에서 방금 기록한 게 아니라면 먼저 query_health_history로 조회해서 '(id:...)' 값을 확인하세요. 어떤 기록을 말하는지 애매하면(여러 후보가 있거나 특정이 안 되면) 수정하지 말고 사용자에게 먼저 확인하세요. 칼로리와 순수 알코올량(g)은 당신이 직접 추정해서 입력하세요.",
    parameters: {
      type: "object",
      properties: {
        timestamp: { type: "number", description: "수정할 기존 기록의 id (query_health_history 결과의 id 값). 새로 기록하는 경우 생략하세요." },
        date: { type: "string", description: "YYYY-MM-DD. 새로 기록할 때 생략하면 오늘 날짜. 기존 기록 수정 시 날짜 자체를 바꾸려면 채우고, 안 바꾸려면 생략." },
        raw_text: { type: "string", description: "사용자가 말한 내용 요약. 새로 기록할 때는 반드시 채우세요. 기존 기록을 수정할 때는 내용을 바꾸는 경우에만 채우고, 안 바꾸려면 생략하세요." },
        alcohol_g: { type: "number", description: "추정 순수 알코올량(g), 없으면 0" },
        calories_est: {
          type: "number",
          description: "추정 칼로리(kcal). 식사든 운동이든 열량이 관련된 내용이 하나라도 언급되면 항상 채우세요 - 정확히 알기 어려운 운동(예: 푸쉬업, 스쿼트)이라도 대략치를 추정해서 적고, 절대 비워두지 마세요.",
        },
        meal_type: {
          type: "string",
          enum: ["집밥", "외식", "간편식", "급식", "반주", "간식", "음료", "음주", "기타"],
          description:
            "식단/음주 기록일 때만 채우세요. 집밥=재료를 직접 가열·조리함(밀키트를 끓이거나 볶는 것 포함), 간편식=이미 다 조리된 것을 그대로 먹음(배달, 편의점/마트 완제품, 로티세리 치킨 등 - 데우기만 한 것도 포함), 외식=식당에서 먹음, 급식=회사/기관 급식, 반주=식사에 곁들인 가벼운 음주, 음주=식사 없이 술만, 간식=가벼운 주전부리, 음료=물 외의 마실 것. 사용자의 교대근무 특성상 '아침/점심/저녁/야식' 같은 시간대 구분은 의미 없으니 사용하지 마세요 - 시간은 이미 별도로 기록됩니다.",
        },
        assessment: {
          type: "string",
          enum: ["건강식", "고지방", "고탄수", "과식", "폭식", "X"],
          description: "식단 품질/양에 대한 당신의 평가. 단순 음료나 소량 간식처럼 평가가 무의미하면 X. 술이 포함된 기록이라면 이 값은 서버가 그날 누적량 기준으로 자동 계산/덮어쓰므로 비워두거나 X로 두세요.",
        },
        sleep_start: { type: "string", description: "수면 시작(취침) 시각, HH:MM 24시간제. 수면이 언급됐다면 반드시 sleep_end와 함께 채우세요 - 총 수면시간은 이 둘로 자동 계산되니 직접 계산하지 마세요." },
        sleep_end: { type: "string", description: "수면 종료(기상) 시각, HH:MM 24시간제. sleep_start와 반드시 함께 채우세요." },
        event_time: {
          type: "string",
          description:
            "이 사건이 실제로 일어난 시각, HH:MM 24시간제. 지금 막 일어난 일을 실시간으로 기록할 때는 생략하세요(기록 시각이 곧 실제 시각이므로). 하지만 과거에 있었던 일을 나중에 소급해서 입력할 때는(예: 사용자가 '어제 출근길에 걸었는데 깜빡하고 기록을 안 했어'처럼 말할 때) 반드시 채우세요 - 비워두면 화면에 지금 입력하는 시각이 실제 발생 시각인 것처럼 잘못 표시됩니다. 수면 기록은 sleep_start가 이미 실제 시각 역할을 하므로 보통 생략해도 됩니다.",
        },
        exercise: { type: "boolean", description: "운동/스트레칭 여부" },
        exercise_type: {
          type: "string",
          enum: ["aerobic", "anaerobic", "mixed"],
          description: "exercise가 true일 때만 채우세요. aerobic=유산소(조깅/걷기/계단오르기 등 지속적 심박 상승 운동), anaerobic=무산소(푸쉬업/스쿼트/웨이트 등 근력 위주 운동), mixed=둘 다 섞인 경우.",
        },
      },
    },
  },
  {
    name: "update_health_targets",
    description: "수면/음주 등 목표치를 수정합니다.",
    parameters: { type: "object", properties: { sleep_hours_min: { type: "number" }, weekly_alcohol_limit_g: { type: "number" } } },
  },
  {
    name: "query_health_history",
    description:
      "지정한 기간의 식사/음주/수면/운동 기록을 날짜·근무코드와 함께 조회합니다. 매 대화에 자동으로 보이는 최근 3건만으로 충분하면 호출하지 마세요 - 그보다 더 과거이거나, 특정 기간의 집계·평균·패턴(예: '이번 주 평균 음주량', '지난달 수면 패턴')을 물었을 때만 호출하세요.",
    parameters: {
      type: "object",
      properties: { start_date: { type: "string", description: "조회 시작일, YYYY-MM-DD" }, end_date: { type: "string", description: "조회 종료일(포함), YYYY-MM-DD" } },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "delete_health_entry",
    description:
      "식단/음주/수면/운동 기록 하나를 삭제합니다. 정확한 id가 필요합니다 - 이번 대화에서 방금 log_health_entry로 기록한 게 아니라면 먼저 query_health_history로 조회해서 '(id:...)' 값을 확인한 뒤 호출하세요. 어떤 기록을 말하는지 애매하면(여러 후보가 있거나 특정이 안 되면) 삭제하지 말고 사용자에게 먼저 확인하세요.",
    parameters: {
      type: "object",
      properties: { timestamp: { type: "number", description: "삭제할 기록의 id (query_health_history 결과의 id 값)" } },
      required: ["timestamp"],
    },
  },
];

const RECALL_MEMORY_TOOL: FunctionDeclaration = {
  name: "recall_original_conversation",
  description:
    "[예전 대화에서 기억하는 내용] 블록에 뜬 요약 기억 중 하나가 너무 짧게 요약되어 있어서 더 자세한 원본 대화가 필요할 때, 그 번호를 골라 원본 대화 전후 턴을 직접 확인합니다. 모든 기억에 다 쓸 필요는 없고, 사용자가 그 기억에 대해 더 자세히 물어보거나 디테일이 중요한 경우에만 사용하세요.",
  parameters: {
    type: "object",
    properties: { index: { type: "integer", description: "[예전 대화에서 기억하는 내용] 목록에서의 번호 (1부터 시작)" } },
    required: ["index"],
  },
};

// Gemini's own google_search tool runs from a datacenter IP and gets blocked
// by sites that specifically target crawlers (confirmed for real against
// m.dcinside.com: google_search came back empty/slow, but a plain fetch from
// this app - running on the user's own home network - returned the full page
// instantly). This fetches a URL the user already gave directly, from here,
// sidestepping that block. Takes a free-text url (unlike
// recall_original_conversation's index-based design) because the URL comes
// from the conversation itself, not something the model has to invent from a
// search snippet.
const FETCH_WEBPAGE_TOOL: FunctionDeclaration = {
  name: "fetch_webpage",
  description:
    "사용자가 보낸 특정 URL의 페이지 내용을 이 프로그램이 직접 접속해서 읽어옵니다. 구글 검색으로는 크롤링이 차단되어 못 읽는 페이지(디시인사이드 등 커뮤니티 사이트 포함)도 이 도구로는 읽을 수 있습니다. 사용자가 직접 링크를 보냈을 때 사용하세요.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "읽어올 페이지의 전체 URL" },
      query: { type: "string", description: "페이지가 너무 길 때 어느 부분을 찾아야 하는지 - 찾는 내용/키워드 (선택)" },
    },
    required: ["url"],
  },
};

const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = [WEB_SEARCH_TOOL, ...FILE_TOOLS, ...HEALTH_TOOLS, RECALL_MEMORY_TOOL, FETCH_WEBPAGE_TOOL];
// Used by "gemini-fast" (searchMode "builtin") instead of the above - no
// web_search declaration, since that mode hands search to Gemini's own
// built-in google_search tool rather than our custom function.
const NON_SEARCH_TOOL_DECLARATIONS: FunctionDeclaration[] = [...FILE_TOOLS, ...HEALTH_TOOLS, RECALL_MEMORY_TOOL, FETCH_WEBPAGE_TOOL];

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface ToolExecutionResult {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  isError: boolean;
}

// Unchanged business logic from the old file - only the wrapping shape at the
// call site changed (FunctionResultStep -> ToolExecutionResult), since
// generateContent's functionResponse Part shape differs from the Interactions
// API's function_result step shape.
function executeFunctionCallLogic(
  name: string,
  args: Record<string, unknown>,
  memoryCandidates: MemoryCandidate[]
): ToolExecutionResult {
  try {
    if (name === "recall_original_conversation") {
      const a = args as { index?: number };
      const index = typeof a.index === "number" ? a.index : -1;
      const candidate = memoryCandidates[index - 1];
      if (!candidate) {
        return { text: "해당 번호의 기억을 찾을 수 없습니다. [예전 대화에서 기억하는 내용] 목록의 번호를 다시 확인하세요.", images: [], isError: true };
      }
      if (!candidate.id) {
        return { text: "이건 요약된 기억이 아니라 최근 대화 원문이라, 더 불러올 원본이 따로 없습니다.", images: [], isError: false };
      }
      return { text: recallOriginalConversation(candidate.id), images: [], isError: false };
    }
    if (name === "list_files") {
      const a = args as { path?: string };
      const entries = listFiles(a.path ?? ".");
      const text = entries.length === 0 ? "(빈 폴더입니다)" : entries.map((e) => `${e.isDirectory ? "[폴더] " : ""}${e.name}`).join("\n");
      return { text, images: [], isError: false };
    }
    if (name === "read_file") {
      const a = args as { path: string };
      const result = readFileSafe(a.path);
      if (result.kind === "text") return { text: result.text, images: [], isError: false };
      if (result.kind === "image") return { text: "(이미지 파일)", images: [{ data: result.data, mimeType: result.mediaType }], isError: false };
      return { text: result.message, images: [], isError: true };
    }
    if (name === "read_files") {
      const a = args as { paths: string[] };
      const files = readFilesSafe(a.paths);
      const textParts: string[] = [];
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const { path: p, result } of files) {
        if (result.kind === "text") textParts.push(`=== ${p} ===\n${result.text}`);
        else if (result.kind === "image") {
          textParts.push(`=== ${p} === (이미지, 첨부됨)`);
          images.push({ data: result.data, mimeType: result.mediaType });
        } else textParts.push(`=== ${p} === (읽기 실패: ${result.message})`);
      }
      return { text: textParts.join("\n\n"), images, isError: false };
    }
    if (name === "write_record_file") {
      const a = args as { content: string; mode?: "append" | "overwrite" };
      const result = writeRecordFile(a.content, a.mode ?? "append");
      return { text: result.message, images: [], isError: !result.ok };
    }
    if (name === "register_shift_rule") {
      const a = args as { pattern: string; anchor_date: string; effective_from: string };
      addRotationRule(a.pattern, a.anchor_date, a.effective_from);
      return { text: "근무 규칙이 등록되었습니다.", images: [], isError: false };
    }
    if (name === "set_shift_override") {
      const a = args as { date: string; code: string; reason?: string };
      setShiftOverride(a.date, a.code, a.reason);
      return { text: "예외 근무가 기록되었습니다.", images: [], isError: false };
    }
    if (name === "set_shift_override_range") {
      const a = args as { start_date: string; end_date: string; code: string; reason?: string };
      setShiftOverrideRange(a.start_date, a.end_date, a.code, a.reason);
      return { text: "기간 전체가 예외 근무로 기록되었습니다.", images: [], isError: false };
    }
    if (name === "correct_past_shift") {
      const a = args as { date: string; code: string };
      correctPastShift(a.date, a.code);
      return { text: "과거 근무 기록이 정정되었습니다.", images: [], isError: false };
    }
    if (name === "log_health_entry") {
      const a = args as {
        timestamp?: number;
        date?: string;
        raw_text?: string;
        alcohol_g?: number;
        calories_est?: number;
        meal_type?: "집밥" | "외식" | "간편식" | "급식" | "반주" | "간식" | "음료" | "음주" | "기타";
        assessment?: "건강식" | "고지방" | "고탄수" | "과식" | "폭식" | "X";
        sleep_start?: string;
        sleep_end?: string;
        event_time?: string;
        exercise?: boolean;
        exercise_type?: "aerobic" | "anaerobic" | "mixed";
      };
      if (a.timestamp !== undefined) {
        const { timestamp, ...patch } = a;
        const ok = updateHealthLog(timestamp, patch);
        return { text: ok ? "수정되었습니다." : "해당 id의 기록을 찾을 수 없습니다.", images: [], isError: !ok };
      }
      const { timestamp: _unused, ...rest } = a;
      appendHealthLog({ date: a.date ?? todayStr(), ...rest, raw_text: a.raw_text ?? "" });
      return { text: "기록되었습니다.", images: [], isError: false };
    }
    if (name === "update_health_targets") {
      const a = args as { sleep_hours_min?: number; weekly_alcohol_limit_g?: number };
      updateTargets(a);
      return { text: "목표치가 수정되었습니다.", images: [], isError: false };
    }
    if (name === "query_health_history") {
      const a = args as { start_date: string; end_date: string };
      const entries = queryHealthLogs(a.start_date, a.end_date);
      const text = entries.length === 0 ? "해당 기간에 기록된 데이터가 없습니다." : entries.map((e) => `${e.date} [근무:${e.shiftCode ?? "?"}] (id:${e.timestamp}): ${e.summary}`).join("\n");
      return { text, images: [], isError: false };
    }
    if (name === "delete_health_entry") {
      const a = args as { timestamp: number };
      const ok = deleteHealthLog(a.timestamp);
      return { text: ok ? "삭제되었습니다." : "해당 id의 기록을 찾을 수 없습니다.", images: [], isError: !ok };
    }
    return { text: "알 수 없는 도구입니다.", images: [], isError: true };
  } catch (err) {
    return { text: String(err), images: [], isError: true };
  }
}

interface UsageLike {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

function logTokenUsage(label: string, usage: UsageLike | undefined): void {
  if (!usage) {
    console.log(`[usage] ${label}: (no usage data returned)`);
    return;
  }
  const cached = usage.cachedContentTokenCount ?? 0;
  const input = usage.promptTokenCount ?? 0;
  const pct = input > 0 ? ((cached / input) * 100).toFixed(0) : "0";
  console.log(`[usage] ${label}: input=${input}, cached=${cached} (${pct}%), output=${usage.candidatesTokenCount ?? 0}, total=${usage.totalTokenCount ?? 0}`);
}

// searchQueries defaults to 0 here (unlike the old file's trackCost, which
// derived it from google_search_call steps on the SAME call) - with this
// architecture the search query count is tracked separately, once, at the
// single call site that actually performs call "B" (see executeWebSearch).
function trackCost(usage: UsageLike | undefined, searchQueries = 0): void {
  recordGeminiUsage({
    inputTokens: usage?.promptTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    searchQueries,
  });
}

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

interface StreamResult {
  text: string;
  functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage?: UsageLike;
  modelParts: Part[];
  // Only ever populated in "builtin" search mode - the only mode where
  // Gemini's own google_search tool can run inside this call. Confirmed for
  // real that groundingMetadata.webSearchQueries only ever lands on the
  // LAST streamed chunk (long after any use it'd have as a live signal), but
  // it's still the only way to know afterward how many real search queries
  // this call actually spent, for cost tracking.
  searchQueries: number;
}

async function streamGenerateContent(
  client: GoogleGenAI,
  model: string,
  contents: Content[],
  config: Record<string, unknown>,
  onFunctionCallSeen?: (name: string) => void
): Promise<StreamResult> {
  const stream = await client.models.generateContentStream({ model, contents: contents as never, config: config as never });
  let text = "";
  const functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const modelParts: Part[] = [];
  let usage: UsageLike | undefined;
  let searchQueries = 0;
  let reportedFirstCall = false;

  for await (const chunk of stream) {
    usage = (chunk as { usageMetadata?: UsageLike }).usageMetadata ?? usage;
    const cand = (chunk as { candidates?: Array<{ content?: { parts?: Part[] }; groundingMetadata?: { webSearchQueries?: string[] } }> }).candidates?.[0];
    const queriesThisChunk = cand?.groundingMetadata?.webSearchQueries?.length ?? 0;
    if (queriesThisChunk > searchQueries) searchQueries = queriesThisChunk;
    for (const p of cand?.content?.parts ?? []) {
      if (p.functionCall) {
        const fc = p.functionCall as { id?: string; name?: string; args?: Record<string, unknown> };
        if (fc.name) {
          functionCalls.push({ id: fc.id ?? `call_${functionCalls.length}`, name: fc.name, args: fc.args ?? {} });
          if (!reportedFirstCall) {
            reportedFirstCall = true;
            onFunctionCallSeen?.(fc.name);
          }
        }
        modelParts.push(p);
      } else if (p.text && !p.thought) {
        text += p.text as string;
        modelParts.push(p);
      }
      // Thought parts (p.thought === true) are deliberately dropped from
      // modelParts - they're not meant to be echoed back as conversation
      // history, and Gemini doesn't require them to be.
    }
  }

  return { text, functionCalls, usage, modelParts, searchQueries };
}

// Call "B": a separate, uncached, persona-free generateContent call whose
// only job is running Gemini's real google_search tool and handing back a
// grounded text answer. Deliberately NOT given the cached persona - it
// doesn't need a personality to search the web, and keeping it lean is what
// makes the two-call total cheaper than one big call would be (confirmed for
// real: ~₩1.3 for this call vs the ~₩9+ the persona portion alone would cost
// uncached).
async function executeWebSearch(client: GoogleGenAI, query: string): Promise<string> {
  const t0 = Date.now();
  try {
    const res = await client.models.generateContent({
      model: MODEL(),
      contents: query,
      config: { tools: [{ googleSearch: {} }] },
    });
    console.log(`[perf] call B (web search): ${Date.now() - t0}ms`);
    trackCost(res.usageMetadata as UsageLike, 1);
    return res.text ?? "검색 결과를 가져오지 못했습니다.";
  } catch (err) {
    console.log(`[perf] call B (web search) failed after ${Date.now() - t0}ms`);
    console.error("Gemini web search (call B) failed:", err);
    return "검색 중 오류가 발생했습니다.";
  }
}

function imageToInlinePart(img: { data: string; mediaType: string } | { data: string; mimeType: string }): Part {
  const mimeType = "mimeType" in img ? img.mimeType : img.mediaType;
  return { inlineData: { data: img.data, mimeType } };
}

// A follow-up call occasionally comes back unusable (truly empty, or a
// well-formed-but-blank {"reply":""} per REPLY_SCHEMA) - same transient
// glitch documented in the old file's isBlankTextReply, ported as-is.
function isBlankTextReply(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { reply?: string };
    return !parsed.reply;
  } catch {
    return false;
  }
}

const MAX_TOOL_ITERATIONS = 5;

export class GeminiAssistant implements Assistant {
  private client: GoogleGenAI | null = null;
  private config = loadConfig();
  // Cache is created lazily on first use (not in the constructor) so a
  // missing/invalid API key still fails the same clean "not ready" way as
  // before, rather than throwing during construction. Two SEPARATE caches,
  // not one - confirmed for real that once a cache has `tools` baked in, the
  // API hard-rejects (400) any call referencing it that also tries to set
  // `toolConfig` (e.g. functionCallingConfig.mode: "NONE") to suppress
  // calling during the format-only phase 2 step: "CachedContent can not be
  // used with GenerateContent request setting system_instruction, tools or
  // tool_config." A tools-free cache is the only way phase 2 can reliably
  // produce plain JSON instead of occasionally attempting another function
  // call (confirmed for real: a search-inviting prompt did exactly that
  // against the single-cache version, leaving phase 2's own text empty).
  private cacheWithToolsName: string | null = null;
  private cacheNoToolsName: string | null = null;
  private cacheExpiresAt = 0;

  // "custom-tool" (default, backs the "gemini" provider): search goes
  // through our own function-declared web_search tool + a separate call "B"
  // - slower and marginally more expensive per search-needing turn, but the
  // function-call part streams back with real lead time, which is what lets
  // the avatar show a distinct "searching" animation at all.
  // "builtin" (backs "gemini-fast"): search goes through Gemini's own
  // built-in google_search tool in the SAME single cached call - cheaper and
  // faster (no call "B" round trip), but confirmed for real that this tool
  // gives no usable mid-wait signal, so onStateHint never reports
  // "searching" in this mode - the avatar just shows "thinking" the whole
  // time, same as it did before any of this caching work existed.
  // Tracks which key-pool "version" this.client/caches were built against
  // (see geminiKeys.ts) - a key rotation bumps that version, and getClient()
  // below notices the mismatch and rebuilds both the client and the caches,
  // since a cache created under one API key's project is invalid under another.
  private clientKeyVersion = -1;

  constructor(private readonly searchMode: "custom-tool" | "builtin" = "custom-tool") {}

  isReady(): boolean {
    return hasGeminiKey();
  }

  private getClient(): GoogleGenAI {
    const currentVersion = getKeyVersion();
    if (!this.client || this.clientKeyVersion !== currentVersion) {
      const apiKey = getActiveGeminiKey();
      if (!apiKey) throw new Error("Gemini API 키가 설정되지 않았습니다.");
      this.client = new GoogleGenAI({ apiKey });
      this.clientKeyVersion = currentVersion;
      this.cacheWithToolsName = null;
      this.cacheNoToolsName = null;
      this.cacheExpiresAt = 0;
    }
    return this.client;
  }

  // Recreated whenever missing, expired, or (rarely) rejected by the API as
  // stale - a 60s safety margin before the real TTL avoids a request landing
  // right as the cache expires mid-flight. Both caches are (re)created
  // together so they always share the same lifetime/expiry bookkeeping.
  private async ensureCaches(): Promise<{ withTools: string; noTools: string }> {
    const client = this.getClient();
    const now = Date.now();
    if (this.cacheWithToolsName && this.cacheNoToolsName && now < this.cacheExpiresAt - 60_000) {
      return { withTools: this.cacheWithToolsName, noTools: this.cacheNoToolsName };
    }

    // "builtin" mixes Gemini's server-executed google_search tool with our
    // own function-declared tools in one call - confirmed for real that this
    // combination is rejected (400) unless the cache's own toolConfig
    // explicitly opts in via includeServerSideToolInvocations.
    const withToolsConfig =
      this.searchMode === "builtin"
        ? {
            systemInstruction: this.config.systemPrompt,
            tools: [{ googleSearch: {} }, { functionDeclarations: NON_SEARCH_TOOL_DECLARATIONS as never }],
            toolConfig: { functionCallingConfig: {}, includeServerSideToolInvocations: true },
            ttl: `${CACHE_TTL_SECONDS}s`,
          }
        : {
            systemInstruction: this.config.systemPrompt,
            tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS as never }],
            ttl: `${CACHE_TTL_SECONDS}s`,
          };

    const [withTools, noTools] = await Promise.all([
      client.caches.create({ model: this.config.geminiModel, config: withToolsConfig as never }),
      client.caches.create({
        model: this.config.geminiModel,
        config: { systemInstruction: this.config.systemPrompt, ttl: `${CACHE_TTL_SECONDS}s` },
      }),
    ]);
    this.cacheWithToolsName = withTools.name!;
    this.cacheNoToolsName = noTools.name!;
    this.cacheExpiresAt = now + CACHE_TTL_SECONDS * 1000;
    console.log(
      `[cache] created caches: with-tools=${this.cacheWithToolsName} (${withTools.usageMetadata?.totalTokenCount ?? "?"}tok), no-tools=${this.cacheNoToolsName} (${noTools.usageMetadata?.totalTokenCount ?? "?"}tok)`
    );
    return { withTools: this.cacheWithToolsName, noTools: this.cacheNoToolsName };
  }

  // Wraps a cache-referencing call with exactly one retry after forcing both
  // caches fresh - covers the rare case where our locally-tracked expiry
  // drifts from the server's own (e.g. this process was asleep/suspended)
  // and an already-evicted cache gets referenced anyway.
  private async withCache<T>(pick: (names: { withTools: string; noTools: string }) => string, fn: (cacheName: string) => Promise<T>): Promise<T> {
    const names = await this.ensureCaches();
    try {
      return await fn(pick(names));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("NOT_FOUND") && !message.includes("cache")) throw err;
      console.warn("Gemini cache reference failed, recreating both once:", message);
      this.cacheWithToolsName = null;
      this.cacheNoToolsName = null;
      const freshNames = await this.ensureCaches();
      return fn(pick(freshNames));
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
    if (!this.isReady()) {
      return { reply: "아직 Gemini API 키가 설정되지 않았어요. .env 파일에 GEMINI_API_KEY를 넣고 앱을 다시 시작해주세요.", emotion: "sad" };
    }

    const { prefix, memoryCandidates } = await buildContextPrefix(
      userText,
      session.turns,
      session.startedAt,
      idleGapMs,
      source,
      this.searchMode === "builtin" ? "gemini-fast" : "gemini"
    );
    const input = prefix ? `${prefix}\n\n[새 메시지]\n${userText}` : userText;
    session.turns.push({ role: "user", text: userText, timestamp: Date.now() });

    const userParts: Part[] = images && images.length > 0 ? [...images.map(imageToInlinePart), { text: input }] : [{ text: input }];

    const sendT0 = Date.now();
    // Each attempt builds its own fresh `contents` (via generateReply) so a
    // quota-triggered retry on the next key starts clean rather than resuming
    // half-built state from the key that just ran out. One attempt per
    // registered key - once every key has been tried, the real error (or the
    // standard "all keys exhausted" case, which surfaces as the same quota
    // error on the last key) falls through to the catch below.
    const maxAttempts = Math.max(1, getKeyStatus().total);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const client = this.getClient();
        const reply = await this.generateReply(client, userParts, memoryCandidates, onStateHint);
        if (reply.reply) {
          session.turns.push({ role: "assistant", text: reply.reply, timestamp: Date.now() });
        }
        console.log(`[perf] TOTAL send() time: ${Date.now() - sendT0}ms (attempt ${attempt + 1}/${maxAttempts})`);
        return reply;
      } catch (err) {
        if (AUTO_ROTATE_ON_QUOTA && isQuotaExceededError(err) && rotateToNextGeminiKey()) {
          continue;
        }
        console.error("Gemini API error:", err);
        return { reply: "미안해요, 지금 대답하는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.", emotion: "sad" };
      }
    }
    return { reply: "등록된 Gemini API 키를 전부 소진했어요. 새 키를 추가하거나 할당량이 풀릴 때까지 기다려주세요.", emotion: "sad" };
  }

  private async generateReply(
    client: GoogleGenAI,
    userParts: Part[],
    memoryCandidates: MemoryCandidate[],
    onStateHint?: (state: AssistantStateHint) => void
  ): Promise<AssistantReply> {
    const contents: Content[] = [{ role: "user", parts: userParts }];
    {
      // Phase 1: tool-calling loop. No response schema here - confirmed for
      // real that combining a JSON responseSchema with available tools in
      // the SAME call makes the model occasionally invent a spurious tool
      // call even on messages that need no tool at all. Mirrors local.ts's
      // own two-phase Ollama pattern for the identical underlying reason.
      let iterations = 0;
      let functionCalls: StreamResult["functionCalls"] = [];

      do {
        const callT0 = Date.now();
        const result = await this.withCache(
          (names) => names.withTools,
          (cacheName) =>
            streamGenerateContent(client, this.config.geminiModel, contents, { cachedContent: cacheName }, (name) => {
              onStateHint?.(name === "web_search" ? "searching" : "thinking");
            })
        );
        console.log(`[perf] gemini call (round ${iterations}): ${Date.now() - callT0}ms`);
        logTokenUsage(`round ${iterations}`, result.usage);
        if (result.searchQueries > 0) console.log(`[perf] web search used (builtin, ${result.searchQueries} queries)`);
        trackCost(result.usage, result.searchQueries);

        // Always carries this round's own output forward - even a round with
        // no function call (just a plain text answer) has to be recorded
        // here, or phase 2 below would reformat from nothing but the
        // original user message and silently lose whatever the model just
        // said (confirmed for real: this was missing and phase 2 came back
        // empty because it had no idea what "it" was supposed to reformat).
        contents.push({ role: "model", parts: result.modelParts });

        functionCalls = result.functionCalls;
        if (functionCalls.length === 0) break;
        iterations++;
        console.log(`[perf] tool round ${iterations}: model called ${functionCalls.map((c) => c.name).join(", ")}`);

        const responseParts: Part[] = [];
        for (const call of functionCalls) {
          if (call.name === "web_search") {
            const query = (call.args as { query?: string }).query ?? "";
            onStateHint?.("searching");
            const searchResult = query ? await executeWebSearch(client, query) : "검색어가 비어 있습니다.";
            onStateHint?.("thinking");
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { output: searchResult } } });
          } else if (call.name === "fetch_webpage") {
            const a = call.args as { url?: string; query?: string };
            onStateHint?.("searching");
            let pageResult: Record<string, unknown>;
            if (!a.url) {
              pageResult = { error: "url이 비어 있습니다." };
            } else {
              try {
                pageResult = { output: await fetchPageText(a.url, a.query) };
              } catch (err) {
                pageResult = { error: `페이지를 읽지 못했습니다: ${String(err)}` };
              }
            }
            onStateHint?.("thinking");
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: pageResult } });
          } else {
            const outcome = executeFunctionCallLogic(call.name, call.args, memoryCandidates);
            const responseObj: Record<string, unknown> = outcome.isError ? { error: outcome.text } : { output: outcome.text };
            responseParts.push({ functionResponse: { id: call.id, name: call.name, response: responseObj } });
            // Images a tool result carries (e.g. read_file on a photo) ride
            // as separate inlineData parts alongside the functionResponse,
            // not inside it - functionResponse.response is JSON-only.
            for (const img of outcome.images) responseParts.push(imageToInlinePart(img));
          }
        }
        contents.push({ role: "user", parts: responseParts });
      } while (functionCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS);

      // Gemini rejects a generateContent call whose contents end on a
      // "model" turn ("Requests ending with a model turn are not
      // supported") - confirmed for real that a phase 1 round with no tool
      // call at all (just a plain text answer) leaves contents ending there,
      // since nothing afterward appended a user turn. A tool round instead
      // already ends on "user" (the function response), so this instruction
      // is harmless there too - it just asks for the same reformatting that
      // was always the point of phase 2.
      contents.push({ role: "user", parts: [{ text: "방금 내용을 바탕으로, 정해진 JSON 형식(reply, emotion)에 맞춰 주인님께 보여줄 최종 답변을 작성하세요." }] });

      // Phase 2: one final, tool-free, schema-constrained call to shape the
      // actual {reply, emotion} output from whatever phase 1 gathered.
      const formatT0 = Date.now();
      let finalResult = await this.withCache(
        (names) => names.noTools,
        (cacheName) =>
          streamGenerateContent(client, this.config.geminiModel, contents, {
            cachedContent: cacheName,
            responseMimeType: "application/json",
            responseSchema: REPLY_SCHEMA,
          })
      );
      console.log(`[perf] format call: ${Date.now() - formatT0}ms`);
      logTokenUsage("format call", finalResult.usage);
      trackCost(finalResult.usage);

      if (!finalResult.text || isBlankTextReply(finalResult.text)) {
        console.warn("Gemini returned an empty/blank final reply; retrying once");
        finalResult = await this.withCache(
          (names) => names.noTools,
          (cacheName) =>
            streamGenerateContent(client, this.config.geminiModel, contents, {
              cachedContent: cacheName,
              responseMimeType: "application/json",
              responseSchema: REPLY_SCHEMA,
            })
        );
        trackCost(finalResult.usage);
      }

      const parsed = JSON.parse(finalResult.text || "{}") as AssistantReply;
      if (!parsed.reply) {
        console.error("Gemini returned an empty/malformed reply:", finalResult.text);
        // Not a quota/key problem (same key just produced a malformed
        // response) - thrown rather than returned so it lands in send()'s
        // catch, which gives the identical fallback message WITHOUT trying
        // another key or recording this non-answer into session history,
        // matching this file's pre-key-pool behavior exactly.
        throw new Error("Gemini returned an empty/malformed reply");
      }

      return parsed;
    }
  }
}
