interface Window {
  avatarAPI: {
    onStateChange: (callback: (state: string) => void) => void;
    notifyClick: () => void;
    zoom: (direction: 1 | -1) => void;
    showContextMenu: () => void;
    toggleTts: () => void;
    getTtsState: () => Promise<string>;
    onTtsStateChange: (callback: (state: string) => void) => void;
    onHoverChange: (callback: (hovered: boolean) => void) => void;
    toggleHistory: () => void;
    toggleScreenView: () => void;
    getScreenViewState: () => Promise<boolean>;
    onScreenViewStateChange: (callback: (enabled: boolean) => void) => void;
    setProvider: (name: "gemini" | "gemini-fast" | "claude" | "local") => void;
    getProviderState: () => Promise<string>;
    onProviderStateChange: (callback: (provider: string) => void) => void;
  };
}

type ClipName = "idle" | "enter_thinking" | "thinking" | "enter_search" | "search" | "exit_search";

// Each clip is its own separately-rendered video, so frame counts genuinely
// differ between them (the search set was authored independently of the
// original idle/thinking set) - there's no single global count anymore.
const CLIP_FRAME_COUNTS: Record<ClipName, number> = {
  idle: 166,
  enter_thinking: 166,
  thinking: 166,
  enter_search: 161,
  search: 288,
  exit_search: 161,
};

// Source clips are native 72fps (166 frames / 72fps = 2.3056s, matching the
// original video length) - not the 24fps used elsewhere in this project's
// pipeline, so this must stay independent of that convention.
const FPS = 72;
const FRAME_INTERVAL_MS = 1000 / FPS;

const canvas = document.getElementById("avatar-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const fallback = document.getElementById("avatar-fallback") as HTMLDivElement;
const chatToggle = document.getElementById("chat-toggle") as HTMLButtonElement;
const historyToggle = document.getElementById("history-toggle") as HTMLButtonElement;
const menuToggle = document.getElementById("menu-toggle") as HTMLButtonElement;
const ttsToggle = document.getElementById("tts-toggle") as HTMLButtonElement;
const screenviewToggle = document.getElementById("screenview-toggle") as HTMLButtonElement;
const providerToggle = document.getElementById("provider-toggle") as HTMLButtonElement;
const providerMenu = document.getElementById("provider-menu") as HTMLDivElement;
const providerGemini = document.getElementById("provider-gemini") as HTMLButtonElement;
const providerGeminiFast = document.getElementById("provider-gemini-fast") as HTMLButtonElement;
const providerClaude = document.getElementById("provider-claude") as HTMLButtonElement;
const providerLocal = document.getElementById("provider-local") as HTMLButtonElement;
const visibilityToggle = document.getElementById("visibility-toggle") as HTMLButtonElement;
const container = document.getElementById("avatar-container") as HTMLDivElement;

// Source frames are a fixed 384x672 to keep disk/memory usage sane, but the
// avatar window itself can be zoomed up to 500%. Drawing straight into a
// canvas that's still 384x672 and letting CSS stretch it to fill a much
// bigger window compounds a second blurry/blocky upscale on top of the
// first. Instead, size the canvas's actual pixel buffer to match the
// window's current (already-zoomed) size, so drawImage does one direct
// scale from the small source frame to the real display size, and let the
// browser's own smoothing filter soften the jagged edges that a bigger
// scale factor would otherwise expose.
function syncCanvasResolution(): void {
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(window.innerWidth * dpr));
  const targetHeight = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  // Resizing canvas.width/height resets all 2D context state, including
  // smoothing - so this has to be re-applied every time.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

window.addEventListener("resize", syncCanvasResolution);
syncCanvasResolution();

const clipFrames: Record<ClipName, HTMLImageElement[]> = {
  idle: [],
  enter_thinking: [],
  thinking: [],
  enter_search: [],
  search: [],
  exit_search: [],
};

function loadClip(name: ClipName): Promise<void> {
  const loads: Promise<void>[] = [];
  for (let i = 0; i < CLIP_FRAME_COUNTS[name]; i++) {
    const img = new Image();
    const num = String(i).padStart(4, "0");
    const loaded = new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    img.src = `../../../assets/avatar/frames/${name}/frame_${num}.webp`;
    clipFrames[name][i] = img;
    loads.push(loaded);
  }
  return Promise.all(loads).then(() => undefined);
}

// Playback is a small state machine, not a plain video swap. The three
// "resting" loops (idle, thinking, search) sit in a fixed linear chain -
// idle <-> thinking <-> search - and every external request just walks one
// step at a time toward whichever loop was asked for:
// - idle <-> thinking: enter_thinking played forward / the same clip played
//   backward (there's no separate "exit" asset for this pair).
// - thinking <-> search: enter_search / exit_search are two distinct clips
//   (unlike the pair above, these are NOT the same clip played in reverse).
type LoopState = "idle-loop" | "thinking-loop" | "search-loop";
type TransitionState = "enter-thinking" | "exit-thinking" | "enter-search" | "exit-search";
type PlayerState = LoopState | TransitionState;

type ExternalState = "idle" | "thinking" | "searching";
const CHAIN_ORDER: LoopState[] = ["idle-loop", "thinking-loop", "search-loop"];

function externalToLoop(external: ExternalState): LoopState {
  return external === "idle" ? "idle-loop" : external === "thinking" ? "thinking-loop" : "search-loop";
}

let playerState: PlayerState = "idle-loop";
let frameIndex = 0;
let direction: 1 | -1 = 1;
// The latest externally-requested state that hasn't been fully reached yet.
// A one-shot transition already in flight is always allowed to finish
// completely before the next step is taken - never cut short - so a rapid
// idle->thinking->searching->thinking sequence just walks the chain one link
// at a time as each clip naturally finishes, however many links that takes.
let pendingExternal: ExternalState | null = null;

function drawFrame(clip: ClipName, index: number): void {
  const img = clipFrames[clip][index];
  if (!img || !img.complete || img.naturalWidth === 0) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

// Called right after landing in a stable loop, and on every subsequent tick
// spent in one - if there's still a pending target beyond the current loop,
// immediately kicks off the next one-shot toward it instead of waiting for
// something new to request it.
function maybeAdvanceTowardPending(currentLoop: LoopState): void {
  if (pendingExternal === null) return;
  const targetLoop = externalToLoop(pendingExternal);
  const curIdx = CHAIN_ORDER.indexOf(currentLoop);
  const targetIdx = CHAIN_ORDER.indexOf(targetLoop);
  if (curIdx === targetIdx) {
    pendingExternal = null;
    return;
  }

  if (curIdx === 0 && targetIdx > 0) {
    playerState = "enter-thinking";
    frameIndex = 0;
    direction = 1;
  } else if (curIdx === 1 && targetIdx === 0) {
    playerState = "exit-thinking";
    frameIndex = CLIP_FRAME_COUNTS.enter_thinking - 1;
    direction = -1;
  } else if (curIdx === 1 && targetIdx === 2) {
    playerState = "enter-search";
    frameIndex = 0;
    direction = 1;
  } else if (curIdx === 2 && targetIdx <= 1) {
    playerState = "exit-search";
    frameIndex = 0;
    direction = 1;
  }
}

function advanceLoop(clip: ClipName, loop: LoopState): void {
  drawFrame(clip, frameIndex);
  const count = CLIP_FRAME_COUNTS[clip];
  frameIndex += direction;
  if (frameIndex >= count - 1) {
    frameIndex = count - 1;
    direction = -1;
  } else if (frameIndex <= 0) {
    frameIndex = 0;
    direction = 1;
  }
  maybeAdvanceTowardPending(loop);
}

function advance(): void {
  switch (playerState) {
    case "idle-loop":
      advanceLoop("idle", "idle-loop");
      break;

    case "thinking-loop":
      advanceLoop("thinking", "thinking-loop");
      break;

    case "search-loop":
      advanceLoop("search", "search-loop");
      break;

    case "enter-thinking":
      drawFrame("enter_thinking", frameIndex);
      frameIndex += 1;
      if (frameIndex >= CLIP_FRAME_COUNTS.enter_thinking) {
        playerState = "thinking-loop";
        frameIndex = 0;
        direction = 1;
        maybeAdvanceTowardPending("thinking-loop");
      }
      break;

    case "exit-thinking":
      drawFrame("enter_thinking", frameIndex);
      frameIndex -= 1;
      if (frameIndex < 0) {
        playerState = "idle-loop";
        frameIndex = 0;
        direction = 1;
        maybeAdvanceTowardPending("idle-loop");
      }
      break;

    case "enter-search":
      drawFrame("enter_search", frameIndex);
      frameIndex += 1;
      if (frameIndex >= CLIP_FRAME_COUNTS.enter_search) {
        playerState = "search-loop";
        frameIndex = 0;
        direction = 1;
        maybeAdvanceTowardPending("search-loop");
      }
      break;

    case "exit-search":
      drawFrame("exit_search", frameIndex);
      frameIndex += 1;
      if (frameIndex >= CLIP_FRAME_COUNTS.exit_search) {
        playerState = "thinking-loop";
        frameIndex = 0;
        direction = 1;
        maybeAdvanceTowardPending("thinking-loop");
      }
      break;
  }
}

function requestState(external: ExternalState): void {
  pendingExternal = external;
  // If we're already sitting still in a loop, act on this immediately rather
  // than waiting for the next tick to notice - a transition already in
  // flight will pick it up itself once it lands.
  if (playerState === "idle-loop" || playerState === "thinking-loop" || playerState === "search-loop") {
    maybeAdvanceTowardPending(playerState);
  }
}

let lastTick = 0;
function loop(timestamp: number): void {
  if (timestamp - lastTick >= FRAME_INTERVAL_MS) {
    lastTick = timestamp;
    advance();
  }
  requestAnimationFrame(loop);
}

chatToggle.addEventListener("click", () => {
  window.avatarAPI.notifyClick();
});

historyToggle.addEventListener("click", () => {
  window.avatarAPI.toggleHistory();
});

menuToggle.addEventListener("click", () => {
  window.avatarAPI.showContextMenu();
});

ttsToggle.addEventListener("click", () => {
  window.avatarAPI.toggleTts();
});

function applyTtsState(state: string): void {
  ttsToggle.classList.remove("off", "starting", "on");
  ttsToggle.classList.add(state);
  ttsToggle.textContent = state === "off" ? "🔇" : state === "starting" ? "⏳" : "🔊";
  ttsToggle.disabled = state === "starting";
}

window.avatarAPI.onTtsStateChange(applyTtsState);
// Pushed state changes can arrive before this page has finished loading and
// registered the listener above (silently dropped - Electron doesn't queue
// webContents.send for a page that isn't ready yet), which meant the very
// first update this page ever saw could already be "on", skipping past
// "starting" entirely. Pulling the current state once here guarantees this
// page starts in sync no matter how that race falls.
window.avatarAPI.getTtsState().then(applyTtsState);

screenviewToggle.addEventListener("click", () => {
  window.avatarAPI.toggleScreenView();
});

function applyScreenViewState(enabled: boolean): void {
  screenviewToggle.classList.toggle("off", !enabled);
}

window.avatarAPI.onScreenViewStateChange(applyScreenViewState);
window.avatarAPI.getScreenViewState().then(applyScreenViewState);

// Clicking the main button now opens/closes the 3-option menu instead of
// directly cycling - with three providers, a cycle means the one you want is
// often one extra click away, so explicit selection is clearer.
providerToggle.addEventListener("click", () => {
  providerMenu.classList.toggle("open");
});

function selectProvider(name: "gemini" | "gemini-fast" | "claude" | "local"): void {
  window.avatarAPI.setProvider(name);
  providerMenu.classList.remove("open");
}

providerGemini.addEventListener("click", () => selectProvider("gemini"));
providerGeminiFast.addEventListener("click", () => selectProvider("gemini-fast"));
providerClaude.addEventListener("click", () => selectProvider("claude"));
providerLocal.addEventListener("click", () => selectProvider("local"));

const PROVIDER_ICONS: Record<string, string> = { gemini: "⚡", "gemini-fast": "💨", claude: "🧠", local: "🦙" };

function applyProviderState(provider: string): void {
  providerToggle.classList.toggle("claude", provider === "claude");
  providerToggle.classList.toggle("local", provider === "local");
  providerToggle.classList.toggle("gemini-fast", provider === "gemini-fast");
  providerToggle.textContent = PROVIDER_ICONS[provider] ?? "⚡";
  providerGemini.classList.toggle("active", provider === "gemini");
  providerGeminiFast.classList.toggle("active", provider === "gemini-fast");
  providerClaude.classList.toggle("active", provider === "claude");
  providerLocal.classList.toggle("active", provider === "local");
}

window.avatarAPI.onProviderStateChange(applyProviderState);
window.avatarAPI.getProviderState().then(applyProviderState);

// Purely a local display preference for this window (doesn't affect chat
// behavior at all, unlike tts/screenview/provider above), so it lives in
// localStorage instead of round-tripping through the main process.
const BUTTONS_PINNED_STORAGE_KEY = "npc-buttons-pinned";

function loadButtonsPinned(): boolean {
  try {
    const stored = localStorage.getItem(BUTTONS_PINNED_STORAGE_KEY);
    // Default to pinned (today's "always visible" behavior) so this is
    // opt-in rather than making existing buttons suddenly vanish.
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

function applyButtonsPinned(pinned: boolean): void {
  container.classList.toggle("buttons-pinned", pinned);
  visibilityToggle.classList.toggle("off", !pinned);
}

let buttonsPinned = loadButtonsPinned();
applyButtonsPinned(buttonsPinned);

visibilityToggle.addEventListener("click", () => {
  buttonsPinned = !buttonsPinned;
  applyButtonsPinned(buttonsPinned);
  try {
    localStorage.setItem(BUTTONS_PINNED_STORAGE_KEY, buttonsPinned ? "1" : "0");
  } catch {
    // Not critical if the preference doesn't survive a restart.
  }
});

// Pushed from the main process (see index.ts) since the avatar body's own
// -webkit-app-region: drag means this page never receives real mousemove/
// hover events for it directly - only the OS-level cursor-vs-window-bounds
// check on the other end of this can tell "is the cursor over the avatar".
window.avatarAPI.onHoverChange((hovered) => {
  container.classList.toggle("avatar-hovered", hovered);
});

container.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    window.avatarAPI.zoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false }
);

container.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.avatarAPI.showContextMenu();
});

window.avatarAPI.onStateChange((state) => {
  // "screen" (screen-recognition) has no dedicated clip yet - it reuses the
  // thinking loop as a placeholder until that asset exists.
  if (state === "idle") requestState("idle");
  else if (state === "searching") requestState("searching");
  else requestState("thinking");
});

Promise.all([
  loadClip("idle"),
  loadClip("enter_thinking"),
  loadClip("thinking"),
  loadClip("enter_search"),
  loadClip("search"),
  loadClip("exit_search"),
]).then(() => {
  fallback.style.display = "none";
  canvas.style.display = "block";
  requestAnimationFrame(loop);
});
