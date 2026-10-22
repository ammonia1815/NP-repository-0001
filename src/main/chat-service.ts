import { Assistant, AssistantImage, AssistantReply, ConversationSession } from "./assistant-types";
import { appendHistory, loadHistory, ModelProvider, StoredTurn, TurnSource } from "./state";
import { captureScreenshotBase64 } from "./screen";
import { TtsEngine } from "./tts";
import { warmBacklogEmbeddingCache } from "./longterm";
import { isReviewOpportunity, generateHealthReview } from "./health";

export type AvatarState = "screen" | "thinking" | "searching" | "idle";

export interface ChatServiceDeps {
  getActiveAssistant: () => Assistant;
  getActiveProviderName: () => ModelProvider;
  conversationSession: ConversationSession;
  tts: TtsEngine;
  isDreaming: () => boolean;
  isScreenViewEnabled: () => boolean;
  onStateChange: (state: AvatarState) => void;
  // Fired right after each of the two turns (user, then assistant) is
  // appended to history - lets the desktop chat window learn about turns
  // that came from the OTHER client (the phone) without polling, while the
  // window that originated a turn itself already renders it locally and
  // doesn't need this broadcast for its own turns.
  onTurnAppended?: (turn: StoredTurn) => void;
}

export interface ChatServiceResult extends AssistantReply {
  audio: string | null;
  // Mirrors the same-named fields just written onto the user's StoredTurn -
  // lets the desktop chat window's own optimistically-rendered bubble (drawn
  // before this call resolves, so it can't read the stored turn directly)
  // pick up the correct attachment icon once the response comes back.
  hasPhotoAttachment: boolean;
  hasScreenView: boolean;
  // Mirrors the assistant turn's own model field below, for the same reason -
  // the live chat window's bubble for this reply was drawn before the turn
  // existed, so it has to be told afterward which model actually answered.
  model: ModelProvider;
}

// Unlike the dream cycle's idle-detection, the health review needs no
// "watching for a quiet moment" - its result can only ever reach the user at
// the start of an actual conversation turn anyway, so it's checked
// fire-and-forget from inside handleUserMessage rather than on its own timer.
async function maybeRunHealthReview(idleGapMs: number): Promise<void> {
  if (!isReviewOpportunity(idleGapMs)) return;
  await generateHealthReview();
}

// Above this length a reply is assumed to be a long-form analysis rather
// than ordinary chat - narrating the whole thing out loud gets tedious, so
// only the opening and closing paragraphs are spoken (the full text still
// goes to the chat log/history either way, just not through TTS).
const LONG_REPLY_TTS_CHAR_THRESHOLD = 500;

function splitIntoParagraphs(text: string): string[] {
  const byBlankLine = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byBlankLine.length > 1) return byBlankLine;
  // Some replies use single newlines rather than blank-line-separated
  // paragraphs - fall back to that so the length check below still has
  // something to work with.
  return text
    .split(/\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function selectSpokenText(reply: string): string {
  if (reply.length <= LONG_REPLY_TTS_CHAR_THRESHOLD) return reply;
  const paragraphs = splitIntoParagraphs(reply);
  // Only two paragraphs means "first and last" is already the whole thing -
  // nothing to actually trim.
  if (paragraphs.length <= 2) return reply;
  return `${paragraphs[0]}\n\n${paragraphs[paragraphs.length - 1]}`;
}

// Extracted from index.ts's send-message IPC handler so both the desktop
// chat window (via IPC) and the phone app (via the HTTP API) drive the exact
// same logic - history, screenshot, the assistant call, TTS, and the
// fire-and-forget follow-ups - instead of two copies that could drift apart.
export function createChatService(deps: ChatServiceDeps) {
  return async function handleUserMessage(
    text: string,
    source: TurnSource,
    // Mirrors deps.onStateChange but scoped to just this one call - lets a
    // single HTTP request stream its own state changes back to the phone
    // that made it, independent of what's broadcast to the desktop avatar.
    onStateForCaller?: (state: AvatarState) => void,
    // Photos the phone app's user explicitly attached to this message (from
    // their own gallery, up to 5 - enforced client-side). Read the same way
    // the model reads a screenshot or a file from the "엔피 조회 가능 자료"
    // folder - as ordinary inline image content, not a tool call.
    attachedImages?: AssistantImage[]
  ): Promise<ChatServiceResult> {
    // The chat window's input is disabled while dreaming, so this should
    // essentially never be hit - just a defensive backstop against a message
    // slipping through the exact instant a dream cycle starts, so it can't
    // interleave file writes with runDream()'s.
    while (deps.isDreaming()) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const notifyState = (state: AvatarState) => {
      deps.onStateChange(state);
      onStateForCaller?.(state);
    };

    // Captured before appending this turn, so it reflects the gap since the
    // previous exchange (used as the health review's "just resumed activity"
    // proxy below) rather than being zero against the turn we're about to add.
    const priorHistory = loadHistory();
    const priorLastTurn = priorHistory[priorHistory.length - 1];
    const idleGapMs = priorLastTurn ? Date.now() - priorLastTurn.timestamp : Infinity;

    // Images are resolved before the turn is recorded (rather than after, as
    // before) so hasPhotoAttachment/hasScreenView below reflect what actually
    // got attached - e.g. a screen-view capture can silently fail and return
    // null, in which case the turn shouldn't claim to carry a screenshot.
    const images: AssistantImage[] = attachedImages ? [...attachedImages] : [];
    let usedScreenView = false;
    if (deps.isScreenViewEnabled()) {
      notifyState("screen");
      const screenshot = await captureScreenshotBase64();
      if (screenshot) {
        images.push(screenshot);
        usedScreenView = true;
      }
    }

    const userTurn: StoredTurn = {
      role: "user",
      text,
      timestamp: Date.now(),
      source,
      hasPhotoAttachment: Boolean(attachedImages && attachedImages.length > 0),
      hasScreenView: usedScreenView,
    };
    appendHistory(userTurn);
    deps.onTurnAppended?.(userTurn);

    // Screen-viewing is its own phase before "thinking" starts, so the two
    // stay conceptually distinct even though they currently render the same
    // placeholder clip while no dedicated screen-recognition asset exists.
    notifyState("thinking");
    const result = await deps
      .getActiveAssistant()
      .send(text, deps.conversationSession, idleGapMs, source, images.length > 0 ? images : undefined, (state) => {
        notifyState(state === "searching" ? "searching" : "thinking");
      });

    // Keep "thinking" through TTS synthesis too - the reply text being ready
    // isn't the same as being ready to actually deliver it, and switching to
    // idle here made the avatar look done well before the voice line starts.
    const audioBuffer = await deps.tts.synthesize(selectSpokenText(result.reply));
    const audioBase64 = audioBuffer ? audioBuffer.toString("base64") : null;

    // Stamped only now, after screenshot capture + LLM call + TTS synthesis
    // are all done, so (this timestamp - the user turn's timestamp above) is
    // the true total time the user actually waited for this reply.
    const assistantTurn: StoredTurn = {
      role: "assistant",
      text: result.reply,
      emotion: result.emotion,
      timestamp: Date.now(),
      source,
      model: deps.getActiveProviderName(),
    };
    appendHistory(assistantTurn);
    deps.onTurnAppended?.(assistantTurn);

    notifyState("idle");

    // Fire-and-forget: keeps the undreamed backlog's embeddings warm for the
    // next message's semantic search, without adding this call's latency to
    // the reply the caller is waiting on right now.
    warmBacklogEmbeddingCache().catch((err) => console.error("Embedding cache warm-up failed:", err));

    // Also fire-and-forget: cheap to check every message (a small local file
    // read), and only actually calls the API when this message followed a
    // real break (idleGapMs) on a day not yet reviewed.
    maybeRunHealthReview(idleGapMs).catch((err) => console.error("Health review check failed:", err));

    return {
      ...result,
      audio: audioBase64,
      hasPhotoAttachment: userTurn.hasPhotoAttachment ?? false,
      hasScreenView: userTurn.hasScreenView ?? false,
      model: assistantTurn.model as ModelProvider,
    };
  };
}
