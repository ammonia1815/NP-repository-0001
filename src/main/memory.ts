import { getPreviousStopTimestamp, getLastDreamInfo, ModelProvider, TurnSource } from "./state";
import { getHealthSummary, shouldDisplayReview, getLatestReview } from "./health";
import { SessionTurn } from "./assistant-types";
import { findSemanticMemories, MemoryCandidate, checkSleepiness } from "./longterm";
import { loadUserProfile } from "./userprofile";

// How many semantically-relevant memories from PAST sessions to pull in, and how many of
// the CURRENT session's own recent turns to keep. Both are fixed caps so token cost per
// request stays bounded no matter how large the total stored history grows.
const RELEVANT_COUNT = 16;
const RECENT_SESSION_CAP = 20;

// Captured once when this module first loads (i.e. once per app run, before `state.ts`'s
// shutdown handler has a chance to overwrite it) - the timestamp the previous run last
// recorded a clean shutdown at, so the AI can be told how long it was turned off for.
const PREVIOUS_STOPPED_AT = getPreviousStopTimestamp();

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}일`);
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}분`);
  return parts.join(" ");
}

function buildTimeInfo(sessionStart: number): string {
  const lines = [`[현재 시각] ${formatTimestamp(Date.now())}`];
  if (PREVIOUS_STOPPED_AT !== null) {
    const gap = formatDuration(sessionStart - PREVIOUS_STOPPED_AT);
    lines.push(
      `[프로그램 재시작 정보] 이번 실행 시작: ${formatTimestamp(sessionStart)} / 직전 종료: ${formatTimestamp(PREVIOUS_STOPPED_AT)} (약 ${gap} 전)`
    );
  } else {
    lines.push(`[프로그램 재시작 정보] 이번 실행 시작: ${formatTimestamp(sessionStart)} (이전 종료 기록 없음)`);
  }
  return lines.join("\n");
}

// Read fresh (not cached) on every call, since the dream cycle can rewrite
// this file at any time (see longterm.ts's updateUserProfileFromBacklog) and
// the update should be visible on the very next message without a restart.
function buildUserProfileInfo(): string | null {
  const profile = loadUserProfile();
  if (!profile) return null;
  return `[주인 프로필]\n${profile.trim()}`;
}

// The dream/classification cycle runs on a bare, un-personified model call
// (see longterm.ts) that never touches this session, so without this block
// the character has no way to know it ever happened at all - not "vaguely
// aware", genuinely zero information, since it isn't even a logged
// conversation turn anywhere.
function buildDreamInfo(): string {
  const info = getLastDreamInfo();
  if (!info) return "[장기기억 정리 정보] 아직 기억 정리(꿈)를 수행한 적이 없습니다.";
  return `[장기기억 정리 정보] 마지막으로 기억을 정리(꿈)한 시각: ${formatTimestamp(info.ranAt)} (단기 기억 ${info.shortTermCount}건, 장기 기억 ${info.longTermCount}건 정리됨)`;
}

// Only present at all once the backlog has actually crossed the watch
// threshold, and even then only re-surfaces on a cooldown (checkSleepiness
// handles both) - this line existing in a given message's context IS the
// signal to react sleepy, so no separate boolean/count needs parsing here.
function buildSleepinessInfo(): string | null {
  const status = checkSleepiness();
  if (!status.waiting) return null;
  return `[장기기억 대기 상태] 미처리 대화가 ${status.backlogSize}건 쌓여 기억 정리(꿈) 기회를 기다리는 중입니다. 유휴 시간이 충분히 생기면 자동으로 정리됩니다.`;
}

// The health/shift summary used to be something the model had to remember to
// call get_health_summary for, but that tool round-trip roughly doubled
// response time (~9s per Gemini call) any time the topic came up. Since the
// summary is small, folding it into the ambient context on every message -
// the same way the time/lifecycle info already is - avoids that extra round
// trip whenever the model just needs to read it to give advice. Only the
// write operations (logging, overrides, rule changes) remain as real tools.
function buildHealthInfo(idleGapMs: number): string {
  const summary = getHealthSummary();
  const shiftEntries = Object.entries(summary.recent_and_upcoming_shifts);
  if (shiftEntries.length === 0) {
    return "[근무/건강 정보] 등록된 근무 규칙이 아직 없습니다.";
  }

  const lines = ["[근무/건강 정보]"];
  // Without this, the model has no grounded data for what each code's exact
  // clock hours are and silently guesses (a real incident: it assumed N
  // started in the evening of its labeled date, when it actually runs
  // 00:00-08:00 OF that date - so "내일 N까지 몇 시간" math came out wrong).
  // This was already documented in the shift-feature's own planning doc from
  // day one, but had never actually been carried into anything the model
  // reads at runtime - only this ambient block reliably reaches every turn.
  lines.push("근무 코드 기준: N=00:00~08:00(야간), D=08:00~16:00(주간), A=16:00~24:00(오후), X=휴무");
  lines.push(`근무표(최근~향후): ${shiftEntries.map(([d, c]) => `${d}:${c}`).join(", ")}`);
  lines.push(`오늘의 권장 행동: ${summary.today_advice}`);
  if (summary.recent_logs.length > 0) {
    const lastLogs = summary.recent_logs
      .slice(-3)
      .map((l) => `${l.date} "${l.raw_text}"`)
      .join(" / ");
    lines.push(`최근 기록: ${lastLogs}`);
  }
  const targetParts: string[] = [];
  if (summary.targets.sleep_hours_min) targetParts.push(`최소 수면 ${summary.targets.sleep_hours_min}시간`);
  if (summary.targets.weekly_alcohol_limit_g) targetParts.push(`주간 알코올 한도 ${summary.targets.weekly_alcohol_limit_g}g`);
  if (targetParts.length > 0) lines.push(`목표: ${targetParts.join(", ")}`);

  // Whether today's review exists is one question; whether *this* message is
  // an appropriate moment to bring it up is another - shouldDisplayReview
  // judges the latter from the same kind of idle-gap signal the review's own
  // generation trigger uses, so it surfaces once at the start of a resumed
  // conversation instead of on every message for the rest of the day.
  if (shouldDisplayReview(idleGapMs)) {
    const review = getLatestReview()!;
    const concernPart = review.concerns.length > 0 ? `감점 요소: ${review.concerns.join(", ")}. ` : "";
    lines.push(`[오늘의 AI 건강 평가] ${concernPart}지시: ${review.instruction}`);
  }

  return lines.join("\n");
}

function roleLabel(role: "user" | "assistant"): string {
  return role === "user" ? "사용자" : "비서";
}

function formatTurns(turns: SessionTurn[]): string {
  return turns.map((t) => `[${formatTimestamp(t.timestamp)}] ${roleLabel(t.role)}: ${t.text}`).join("\n");
}

// Lets NP honestly answer "are you on my phone or my PC right now" instead
// of truthfully having to say she has no way to know - this was asked
// directly and she correctly (at the time) reported the pipeline didn't
// carry that information at all. A phone-originated message is also a mild
// signal the user may be away from the Uljin desktop rather than sitting at
// it, which she can factor in naturally rather than assuming a fixed location.
function buildSourceInfo(source: TurnSource): string {
  return source === "mobile"
    ? "[접속 기기] 이번 메시지는 휴대폰 앱에서 왔습니다. 주인님이 지금 자택 PC 앞이 아니라 외부에 계실 가능성이 있습니다."
    : "[접속 기기] 이번 메시지는 자택 PC(데스크톱)에서 왔습니다.";
}

// Lets NP honestly answer "지금 무슨 모델로 돌아가고 있어?" the same way
// buildSourceInfo above lets her answer the desktop/mobile question - she has
// no other way to know which backend is actually generating her own reply,
// since the user can switch providers mid-conversation via the tray/avatar
// toggle at any time.
const MODEL_LABELS: Record<ModelProvider, string> = {
  gemini: "Google Gemini",
  "gemini-fast": "Google Gemini (고속 모드)",
  claude: "Anthropic Claude",
  local: "로컬 Ollama 모델 (Qwen3.5)",
};

function buildModelInfo(model: ModelProvider): string {
  return `[현재 응답 모델] 지금 이 답변은 ${MODEL_LABELS[model]}로 생성되고 있습니다.`;
}

// Long-term memory entries are AI-distilled facts, not turns with a role, and semantic
// search hits from the undreamed backlog are raw turns - shown uniformly as dated bullet
// points rather than trying to force both into the role-based transcript format above.
// Numbered (not just dated) so recall_original_conversation can be told "번호 3" the same
// way read_search_result already works off an index rather than a free-text target.
function formatMemoryCandidates(items: MemoryCandidate[]): string {
  return items.map((m, i) => `${i + 1}. (${formatTimestamp(m.timestamp)}) ${m.text}`).join("\n");
}

// Builds the block of text to prepend to a new user message: current wall-clock time and
// app restart info (always included), semantically relevant memories retrieved from past
// sessions, plus this session's own recent turns (since we no longer rely on any provider's
// server-side conversation state - Claude and Gemini are handled identically).
export interface ContextPrefixResult {
  prefix: string;
  // Same list (and same order/numbering) as what got formatted into the
  // "[예전 대화에서 기억하는 내용]" block of `prefix` - lets a provider resolve
  // recall_original_conversation's 1-based index argument back to a real
  // entry id, the same way local.ts's searchState lets read_search_result
  // resolve an index without the model ever handling a real id/URL itself.
  memoryCandidates: MemoryCandidate[];
}

export async function buildContextPrefix(
  query: string,
  sessionTurns: SessionTurn[],
  sessionStart: number,
  idleGapMs: number,
  source: TurnSource,
  model: ModelProvider
): Promise<ContextPrefixResult> {
  const memories = await findSemanticMemories(query, sessionStart, RELEVANT_COUNT);
  const recentSession = sessionTurns.slice(-RECENT_SESSION_CAP);

  const parts: string[] = [buildTimeInfo(sessionStart), buildSourceInfo(source), buildModelInfo(model)];
  const profileInfo = buildUserProfileInfo();
  if (profileInfo) parts.push(profileInfo);
  parts.push(buildDreamInfo(), buildHealthInfo(idleGapMs));
  const sleepinessInfo = buildSleepinessInfo();
  if (sleepinessInfo) parts.push(sleepinessInfo);
  if (memories.length > 0) {
    parts.push(`[예전 대화에서 기억하는 내용]\n${formatMemoryCandidates(memories)}`);
  }
  if (recentSession.length > 0) {
    parts.push(`[지금 세션의 최근 대화]\n${formatTurns(recentSession)}`);
  }
  return { prefix: parts.join("\n\n"), memoryCandidates: memories };
}
