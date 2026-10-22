interface ChatTurn {
  role: string;
  text: string;
  source?: string;
  model?: string;
  hasPhotoAttachment?: boolean;
  hasScreenView?: boolean;
}

interface Window {
  chatAPI: {
    sendMessage: (
      text: string
    ) => Promise<{
      reply: string;
      emotion: string;
      audio: string | null;
      hasPhotoAttachment?: boolean;
      hasScreenView?: boolean;
      model?: string;
    }>;
    getHistory: () => Promise<ChatTurn[]>;
    getDreamingState: () => Promise<boolean>;
    onDreamingStateChange: (callback: (dreaming: boolean) => void) => void;
    onTurnAdded: (callback: (turn: ChatTurn) => void) => void;
  };
}

// How many of the most recent turns to show immediately on launch, before
// this window has been opened even once - otherwise a restart made the chat
// window look empty until the user thought to open the separate date-sorted
// history window.
const PRELOADED_HISTORY_COUNT = 10;

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const form = document.getElementById("input-form") as HTMLFormElement;
const input = document.getElementById("input-box") as HTMLTextAreaElement;
const submitBtn = form.querySelector("button") as HTMLButtonElement;

const DEFAULT_PLACEHOLDER = input.placeholder;
const DREAMING_PLACEHOLDER = "기억을 정리하는 중입니다...";

let dreaming = false;

// Caps how tall the textarea can grow before it scrolls internally instead -
// keeps the last couple of typed lines visible rather than either staying a
// single cramped line or growing without bound and pushing the chat log up.
const MAX_VISIBLE_INPUT_LINES = 2;

function autoResizeInput(): void {
  const style = getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight);
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const maxHeight = lineHeight * MAX_VISIBLE_INPUT_LINES + verticalPadding;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
}

function applyDreamingState(isDreaming: boolean): void {
  dreaming = isDreaming;
  input.disabled = dreaming;
  submitBtn.disabled = dreaming;
  input.placeholder = dreaming ? DREAMING_PLACEHOLDER : DEFAULT_PLACEHOLDER;
}

window.chatAPI.onDreamingStateChange(applyDreamingState);
window.chatAPI.getDreamingState().then(applyDreamingState);

// A small trailing badge (rather than folding this into the bubble's own
// text, or into the source::before icon which is already spoken for) so it
// can be added after the fact once the optimistic user bubble's own send
// call resolves and reveals whether a screenshot was actually attached.
function setAttachmentBadge(bubble: HTMLDivElement, hasPhotoAttachment: boolean, hasScreenView: boolean): void {
  bubble.querySelector(".attach-badge")?.remove();
  if (!hasPhotoAttachment && !hasScreenView) return;
  const badge = document.createElement("span");
  badge.className = "attach-badge";
  badge.textContent = hasPhotoAttachment ? " 📷" : " 👁";
  bubble.appendChild(badge);
}

// Same icon convention as the avatar overlay's own provider-switch buttons
// (avatar/index.html) - ⚡ Gemini, 🧠 Claude, 🦙 local - so the badge reads as
// the same symbol the user already associates with each model there.
const CHAT_MODEL_ICONS: Record<string, string> = { gemini: "⚡", "gemini-fast": "💨", claude: "🧠", local: "🦙" };

function setModelBadge(bubble: HTMLDivElement, model?: string): void {
  bubble.querySelector(".model-badge")?.remove();
  const icon = model ? CHAT_MODEL_ICONS[model] : undefined;
  if (!icon) return;
  const badge = document.createElement("span");
  badge.className = "model-badge";
  badge.textContent = ` ${icon}`;
  bubble.appendChild(badge);
}

function addBubble(
  text: string,
  role: "user" | "assistant",
  pending = false,
  source: string = "desktop",
  hasPhotoAttachment = false,
  hasScreenView = false,
  model?: string
): HTMLDivElement {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}${pending ? " pending" : ""} source-${source}`;
  bubble.appendChild(document.createTextNode(text));
  setAttachmentBadge(bubble, hasPhotoAttachment, hasScreenView);
  setModelBadge(bubble, model);
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

// Runs once on load so a restarted app doesn't show an empty chat window
// until the separate history window is opened.
async function loadRecentHistory(): Promise<void> {
  try {
    const turns = await window.chatAPI.getHistory();
    for (const turn of turns.slice(-PRELOADED_HISTORY_COUNT)) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      addBubble(
        turn.text,
        turn.role,
        false,
        turn.source ?? "desktop",
        turn.hasPhotoAttachment ?? false,
        turn.hasScreenView ?? false,
        turn.model
      );
    }
  } catch (err) {
    console.error("Failed to preload recent history:", err);
  }
}

// Turns that arrived via the phone app while this window was open. Turns
// this window originates itself are already rendered directly below (from
// its own sendMessage() round trip) and are never re-broadcast to it (see
// chat-service.ts's onTurnAppended), so no dedup check is needed here.
window.chatAPI.onTurnAdded((turn) => {
  if (turn.role !== "user" && turn.role !== "assistant") return;
  addBubble(
    turn.text,
    turn.role,
    false,
    turn.source ?? "mobile",
    turn.hasPhotoAttachment ?? false,
    turn.hasScreenView ?? false,
    turn.model
  );
});

// Enter sends (matching the usual chat-app convention); Shift+Enter inserts
// a newline instead, which a plain <textarea> doesn't do on its own since
// Enter's default action there is "submit the enclosing form".
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", autoResizeInput);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (dreaming) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  autoResizeInput();
  input.disabled = true;
  submitBtn.disabled = true;

  const userBubble = addBubble(text, "user");
  const pendingBubble = addBubble("생각 중...", "assistant", true);

  try {
    const result = await window.chatAPI.sendMessage(text);
    // Only knowable once the call resolves (e.g. screen-view capture could
    // have silently failed) - the bubble above was drawn optimistically
    // before that was known.
    setAttachmentBadge(userBubble, result.hasPhotoAttachment ?? false, result.hasScreenView ?? false);
    pendingBubble.textContent = result.reply;
    pendingBubble.classList.remove("pending");
    setModelBadge(pendingBubble, result.model);
    if (result.audio) {
      const audio = new Audio(`data:audio/wav;base64,${result.audio}`);
      audio.play().catch((err) => console.error("audio playback failed:", err));
    }
  } catch (err) {
    pendingBubble.textContent = "오류가 발생했어요. 다시 시도해주세요.";
    pendingBubble.classList.remove("pending");
  } finally {
    // Respect a dream that may have started while this send was in flight,
    // rather than unconditionally re-enabling the input.
    input.disabled = dreaming;
    submitBtn.disabled = dreaming;
    input.focus();
  }
});

input.focus();
loadRecentHistory();
