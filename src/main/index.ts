import "dotenv/config";
import { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, screen, clipboard } from "electron";
import * as path from "path";
import * as os from "os";
import { ClaudeAssistant } from "./claude";
import { GeminiAssistant } from "./gemini";
import { LocalAssistant } from "./local";
import { ConversationSession } from "./assistant-types";
import { loadConfig } from "./config";
import { loadHistory, loadSettings, saveSettings, recordAppStop, ModelProvider } from "./state";
import { TtsEngine } from "./tts";
import { isDreamOpportunity, runDream, warmBacklogEmbeddingCache, backfillMissingEmbeddings } from "./longterm";
import { createChatService } from "./chat-service";
import { startHttpServer, HTTP_PORT } from "./http-server";
import { getOrCreateApiToken } from "./auth";
import { getDailyCostHistory, getSearchQuotaStatus } from "./costTracking";

let avatarWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;
let costTrackingWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clickThrough = false;
let isQuitting = false;
let screenViewEnabled = false;
let isDreaming = false;

const appConfig = loadConfig();
// Both providers are constructed up front (cheap - no network/model loading
// happens in either constructor) so switching between them at runtime via
// activeProvider below is instant, with no "starting" phase to show.
const geminiAssistant = new GeminiAssistant("custom-tool");
const geminiFastAssistant = new GeminiAssistant("builtin");
const claudeAssistant = new ClaudeAssistant();
const localAssistant = new LocalAssistant();
type ProviderName = ModelProvider;
const PROVIDER_OPTIONS: ProviderName[] = ["gemini", "gemini-fast", "claude", "local"];
let activeProvider: ProviderName = appConfig.provider === "anthropic" ? "claude" : "gemini";

function getActiveAssistant() {
  if (activeProvider === "claude") return claudeAssistant;
  if (activeProvider === "local") return localAssistant;
  if (activeProvider === "gemini-fast") return geminiFastAssistant;
  return geminiAssistant;
}

// Shared across both providers (see the ConversationSession comment) so
// toggling mid-conversation doesn't blind whichever one just became active to
// what was just said to the other.
const conversationSession: ConversationSession = { turns: [], startedAt: Date.now() };

const settings = loadSettings();
// The callback fires when the TTS subprocess crashes on its own and
// auto-restarts (see tts.ts) - keeps the tray/avatar speaker icon honest
// about that recovery instead of it looking stuck on "on" while actually dead.
const tts = new TtsEngine(() => {
  broadcastTtsState();
  refreshMenus();
});

// Base size at scale 1.0. 9:16 so a portrait character GIF isn't cropped/squeezed.
const AVATAR_BASE_WIDTH = 180;
const AVATAR_BASE_HEIGHT = 320;
const MIN_SCALE = 1.0;
const MAX_SCALE = 5.0;
const ZOOM_STEP = 0.1;

// A settings value saved before the range changed could sit outside the
// current [MIN_SCALE, MAX_SCALE] bounds - clamp it once at startup.
settings.avatarScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, settings.avatarScale));

const CHAT_WIDTH = 320;
const CHAT_HEIGHT = 400;

const SETTINGS_WIDTH = 280;
const SETTINGS_HEIGHT = 170;

const HISTORY_WIDTH = 420;
const HISTORY_HEIGHT = 600;

const COST_TRACKING_WIDTH = 460;
const COST_TRACKING_HEIGHT = 480;

function avatarSizeForScale(scale: number): { width: number; height: number } {
  return {
    width: Math.round(AVATAR_BASE_WIDTH * scale),
    height: Math.round(AVATAR_BASE_HEIGHT * scale),
  };
}

function createAvatarWindow(): void {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const { width, height } = avatarSizeForScale(settings.avatarScale);

  avatarWindow = new BrowserWindow({
    width,
    height,
    x: workAreaSize.width - width - 40,
    y: workAreaSize.height - height - 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "avatar-preload.js"),
      contextIsolation: true,
    },
  });

  avatarWindow.setAlwaysOnTop(true, "screen-saver");
  avatarWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[avatar console] ${message} (${sourceId}:${line})`);
  });
  avatarWindow.loadFile(path.join(__dirname, "..", "renderer", "avatar", "index.html"));
}

// A GPU hiccup (e.g. another app grabbing the GPU for its own video output,
// per the user's own report) can leave the avatar window's renderer fully
// frozen - animation stopped, every button dead - without Electron itself
// noticing anything wrong enough to recover on its own. Destroying and
// recreating the window is the reliable fix for that (a plain
// webContents.reload() isn't guaranteed to recover a renderer whose GPU
// context itself is wedged), so this is wired to a tray/avatar-menu item the
// user can reach by hand instead of needing a full app restart. Bounds and
// click-through are carried over explicitly since the fresh window would
// otherwise reset to its default bottom-right position and normal
// click-through state.
function refreshAvatarWindow(): void {
  const bounds = avatarWindow?.getBounds();
  avatarWindow?.destroy();

  createAvatarWindow();
  const fresh = avatarWindow;
  if (bounds) fresh?.setBounds(bounds);
  if (clickThrough) fresh?.setIgnoreMouseEvents(true, { forward: true });

  fresh?.webContents.once("did-finish-load", () => {
    broadcastTtsState();
    broadcastScreenViewState();
    broadcastProviderState();
  });
}

function applyAvatarScale(requestedScale: number): void {
  if (!avatarWindow) return;

  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, requestedScale));
  if (newScale === settings.avatarScale) return;
  settings.avatarScale = newScale;
  // Merged onto a freshly-read copy of settings.json, not saved by dumping
  // the long-lived in-memory `settings` object wholesale - that object was
  // snapshotted once at app startup, so blindly re-saving it here silently
  // clobbered any field another part of the app had since written to disk
  // through its own read-modify-write (e.g. a dream cycle's lastDreamedAt via
  // state.ts's setLastDreamedAt) back to its stale startup value. This was a
  // real bug: it meant a dream's progress could be wiped out by something as
  // ordinary as the user zooming the avatar afterward, and since every
  // subsequent app restart would then load that reverted value fresh from
  // disk, a dream could appear to never durably advance at all.
  const onDisk = loadSettings();
  onDisk.avatarScale = newScale;
  saveSettings(onDisk);

  const oldBounds = avatarWindow.getBounds();
  const { width, height } = avatarSizeForScale(newScale);
  // Anchor the bottom-right corner so the avatar grows/shrinks toward the screen edge it sits near.
  const x = oldBounds.x + oldBounds.width - width;
  const y = oldBounds.y + oldBounds.height - height;

  avatarWindow.setBounds({ x, y, width, height });

  // Keep the slider in the settings panel in sync no matter which control
  // (wheel, tray step buttons, or the slider itself) changed the scale.
  settingsWindow?.webContents.send("scale-changed", newScale);
}

function zoomAvatar(direction: 1 | -1): void {
  applyAvatarScale(settings.avatarScale + direction * ZOOM_STEP);
}

function createChatWindow(): void {
  if (!avatarWindow) return;
  const avatarBounds = avatarWindow.getBounds();

  chatWindow = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    minWidth: 240,
    minHeight: 200,
    x: avatarBounds.x - CHAT_WIDTH - 10,
    y: avatarBounds.y + avatarBounds.height - CHAT_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "chat-preload.js"),
      contextIsolation: true,
    },
  });

  chatWindow.setAlwaysOnTop(true, "screen-saver");
  chatWindow.loadFile(path.join(__dirname, "..", "renderer", "chat", "index.html"));

  chatWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    chatWindow?.hide();
  });
}

function toggleChatWindow(): void {
  if (!chatWindow) return;
  if (chatWindow.isVisible()) {
    chatWindow.hide();
  } else {
    chatWindow.show();
    chatWindow.focus();
  }
}

function createSettingsWindow(): void {
  if (!avatarWindow) return;
  const avatarBounds = avatarWindow.getBounds();

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    x: avatarBounds.x + avatarBounds.width - SETTINGS_WIDTH,
    y: Math.max(0, avatarBounds.y - SETTINGS_HEIGHT - 10),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "settings-preload.js"),
      contextIsolation: true,
    },
  });

  settingsWindow.setAlwaysOnTop(true, "screen-saver");
  settingsWindow.loadFile(path.join(__dirname, "..", "renderer", "settings", "index.html"));

  settingsWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    settingsWindow?.hide();
  });
}

function toggleSettingsWindow(): void {
  if (!settingsWindow) return;
  if (settingsWindow.isVisible()) {
    settingsWindow.hide();
  } else {
    settingsWindow.show();
    settingsWindow.focus();
  }
}

function createHistoryWindow(): void {
  const { workAreaSize } = screen.getPrimaryDisplay();

  historyWindow = new BrowserWindow({
    width: HISTORY_WIDTH,
    height: HISTORY_HEIGHT,
    minWidth: 280,
    minHeight: 300,
    x: Math.round((workAreaSize.width - HISTORY_WIDTH) / 2),
    y: Math.round((workAreaSize.height - HISTORY_HEIGHT) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "history-preload.js"),
      contextIsolation: true,
    },
  });

  historyWindow.setAlwaysOnTop(true, "screen-saver");
  historyWindow.loadFile(path.join(__dirname, "..", "renderer", "history", "index.html"));

  historyWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    historyWindow?.hide();
  });
}

// Re-sent every time the window is shown (rather than relying on a single
// load-time fetch) so records added since the last time it was open - e.g.
// this session's own new messages - are never stale.
function toggleHistoryWindow(): void {
  if (!historyWindow) return;
  if (historyWindow.isVisible()) {
    historyWindow.hide();
  } else {
    historyWindow.webContents.send("history-open");
    historyWindow.show();
    historyWindow.focus();
  }
}

function createCostTrackingWindow(): void {
  const { workAreaSize } = screen.getPrimaryDisplay();

  costTrackingWindow = new BrowserWindow({
    width: COST_TRACKING_WIDTH,
    height: COST_TRACKING_HEIGHT,
    minWidth: 320,
    minHeight: 260,
    x: Math.round((workAreaSize.width - COST_TRACKING_WIDTH) / 2),
    y: Math.round((workAreaSize.height - COST_TRACKING_HEIGHT) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "cost-tracking-preload.js"),
      contextIsolation: true,
    },
  });

  costTrackingWindow.setAlwaysOnTop(true, "screen-saver");
  costTrackingWindow.loadFile(path.join(__dirname, "..", "renderer", "cost-tracking", "index.html"));

  costTrackingWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    costTrackingWindow?.hide();
  });
}

function toggleCostTrackingWindow(): void {
  if (!costTrackingWindow) return;
  if (costTrackingWindow.isVisible()) {
    costTrackingWindow.hide();
  } else {
    costTrackingWindow.webContents.send("cost-tracking-open");
    costTrackingWindow.show();
    costTrackingWindow.focus();
    // This and the chat window can end up with a small overlapping corner
    // (both alwaysOnTop at the same level) - moveTop() guarantees this one
    // wins that corner rather than leaving it to whichever window Windows'
    // own z-order happened to favor.
    costTrackingWindow.moveTop();
  }
}

// Best-effort guess at the address a phone on the same WiFi would use to
// reach this PC (Phase 2 of the Android companion app - LAN testing before
// DDNS/Caddy are set up). Falls back to a placeholder if no external IPv4
// interface is found (e.g. ethernet-only with an unusual adapter naming).
function getLanUrl(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return `http://${entry.address}:${HTTP_PORT}`;
      }
    }
  }
  return `http://<PC의 LAN IP>:${HTTP_PORT}`;
}

function broadcastDreamingState(): void {
  chatWindow?.webContents.send("dreaming-state", isDreaming);
}

// Checked on a timer (not per-message - see longterm.ts) so a dream can run
// while the user is genuinely away, rather than only ever getting a chance to
// run at the exact moment they come back and want to chat.
async function maybeRunDream(): Promise<void> {
  if (isDreaming) return;
  if (!isDreamOpportunity()) return;

  isDreaming = true;
  broadcastDreamingState();
  try {
    await runDream();
  } catch (err) {
    console.error("Dream cycle failed:", err);
  } finally {
    isDreaming = false;
    broadcastDreamingState();
  }
}

function buildMenuTemplate(onChange: () => void): Electron.MenuItemConstructorOptions[] {
  return [
    { label: "대화창 열기/닫기", click: toggleChatWindow },
    { label: "대화 기록 보기", click: toggleHistoryWindow },
    { label: "비용 추적 보기 (제미니)", click: toggleCostTrackingWindow },
    { label: "아바타 크기 조절 (슬라이더)", click: toggleSettingsWindow },
    { label: "아바타 확대", click: () => zoomAvatar(1) },
    { label: "아바타 축소", click: () => zoomAvatar(-1) },
    { label: "아바타 새로고침 (멈췄을 때)", click: refreshAvatarWindow },
    {
      label: clickThrough ? "클릭 통과 끄기" : "클릭 통과 켜기",
      click: () => {
        clickThrough = !clickThrough;
        avatarWindow?.setIgnoreMouseEvents(clickThrough, { forward: true });
        onChange();
      },
    },
    {
      label: tts.isStarting() ? "음성 켜는 중..." : tts.isEnabled() ? "음성 끄기 (GPU 자원 반환)" : "음성 켜기",
      enabled: !tts.isStarting(),
      click: toggleTts,
    },
    { type: "separator" },
    { label: "종료", click: () => app.quit() },
  ];
}

function ttsStateLabel(): "off" | "starting" | "on" {
  if (tts.isStarting()) return "starting";
  return tts.isEnabled() ? "on" : "off";
}

function broadcastTtsState(): void {
  avatarWindow?.webContents.send("tts-state", ttsStateLabel());
}

// Shared by the avatar's own speaker-icon button, its right-click menu, and
// the tray menu, so all three always agree on the current state instead of
// each keeping their own copy of this on/off/loading logic.
async function toggleTts(): Promise<void> {
  if (tts.isEnabled()) {
    tts.stop();
    broadcastTtsState();
    refreshMenus();
  } else {
    // start() flips its internal "starting" flag synchronously before its
    // first await, so calling it before broadcasting (not after) is what
    // actually lets this show "켜는 중..." - broadcasting first was
    // capturing the stale "off" state, then jumping straight to "on" once
    // the entire ~7s load finished, with nothing in between ever sent.
    const startPromise = tts.start().catch((err) => console.error("TTS start failed:", err));
    broadcastTtsState();
    refreshMenus();
    await startPromise;
    broadcastTtsState();
    refreshMenus();
  }
}

// The avatar's right-click menu and the tray icon's menu are two independently
// cached Electron Menu objects. A toggle (click-through, TTS) made from one
// only rebuilds itself unless this shared refresh also updates the other -
// otherwise the other's label (e.g. "클릭 통과 켜기" vs "끄기") goes stale
// until it happens to be rebuilt some other way.
function refreshMenus(): void {
  rebuildTrayMenu();
}

function broadcastScreenViewState(): void {
  avatarWindow?.webContents.send("screenview-state", screenViewEnabled);
}

function toggleScreenView(): void {
  screenViewEnabled = !screenViewEnabled;
  broadcastScreenViewState();
}

function broadcastProviderState(): void {
  avatarWindow?.webContents.send("provider-state", activeProvider);
}

// Gemini is the fast, cheap default for everyday messages; Claude Sonnet 5 is
// meant to be switched on only for the occasional question where accuracy
// matters more than speed; Local (Ollama, see local.ts) is for free/offline
// plain chit-chat. There's no async setup for any of the three, so this is a
// plain instant set, unlike the TTS toggle's off/starting/on states - all
// three assistant instances already exist and are always ready. Explicit
// selection (not a cycle) since there are now three options, not two.
function setProvider(name: ProviderName): void {
  activeProvider = name;
  broadcastProviderState();
}

function showAvatarContextMenu(): void {
  if (!avatarWindow) return;
  const menu = Menu.buildFromTemplate(buildMenuTemplate(refreshMenus));
  menu.popup({ window: avatarWindow });
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(refreshMenus)));
}

function createTray(): void {
  // 32x32 source (copied to dist/assets by copy-static.js) so the icon stays
  // sharp at higher Windows display-scaling percentages - Electron downsizes
  // it for the actual tray display size on its own.
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-icon.png"));

  tray = new Tray(icon);
  tray.setToolTip("AI 아바타 비서");

  rebuildTrayMenu();
  tray.on("click", toggleChatWindow);
}

app.whenReady().then(() => {
  createAvatarWindow();
  createChatWindow();
  createSettingsWindow();
  createHistoryWindow();
  createCostTrackingWindow();
  createTray();

  avatarWindow?.webContents.once("did-finish-load", () => {
    broadcastTtsState();
    broadcastScreenViewState();
    broadcastProviderState();
  });

  const autoStart = tts.start();
  broadcastTtsState();
  autoStart
    .then(() => broadcastTtsState())
    .catch((err) => {
      console.error("TTS auto-start failed:", err);
      broadcastTtsState();
    });

  globalShortcut.register("Alt+Space", toggleChatWindow);

  // The undreamed backlog's embedding cache is in-memory only and starts
  // empty on every launch. It's normally refreshed fire-and-forget after
  // each message, but that means the very first message after a restart -
  // exactly when someone is most likely to ask "what were we just talking
  // about?" - would search against an empty cache and find nothing from the
  // previous session, even though the raw text is still sitting right there
  // in history.json. Warming it here, before any message arrives, closes
  // that gap.
  warmBacklogEmbeddingCache().catch((err) => console.error("Initial embedding cache warm-up failed:", err));

  // Checked shortly after launch too (not just on the interval below) so a
  // long idle gap that spanned the app being closed is noticed immediately,
  // rather than waiting up to DREAM_CHECK_INTERVAL_MS for the first check.
  setTimeout(() => {
    maybeRunDream().catch((err) => console.error("Initial dream check failed:", err));
  }, 30 * 1000);
  const DREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    maybeRunDream().catch((err) => console.error("Dream check failed:", err));
    backfillMissingEmbeddings().catch((err) => console.error("Embedding backfill failed:", err));
  }, DREAM_CHECK_INTERVAL_MS);

  // -webkit-app-region: drag (used on the avatar body so it's draggable
  // anywhere on the character) suppresses normal mouse events - mousemove,
  // mouseenter, CSS :hover - for that element in Chromium; only "no-drag"
  // children (the overlay buttons) ever receive real mouse events there.
  // So "hovering the avatar" to reveal the hidden buttons can't be detected
  // from inside the page at all - polling the OS cursor position against the
  // window's own bounds sidesteps that entirely.
  let avatarHovered = false;
  const AVATAR_HOVER_POLL_MS = 120;
  setInterval(() => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = avatarWindow.getBounds();
    const isInside =
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height;
    if (isInside !== avatarHovered) {
      avatarHovered = isInside;
      avatarWindow.webContents.send("avatar-hover", avatarHovered);
    }
  }, AVATAR_HOVER_POLL_MS);
  // Unlike the dream cycle, the health review needs no idle-detection (it
  // isn't watching for a quiet moment) and its result can only ever reach the
  // user at the start of an actual conversation turn anyway - polling for it
  // on a standalone timer would just be checking a "has today changed?" flag
  // no one is waiting on. So it's checked fire-and-forget from inside
  // send-message instead (see below), the same way the embedding cache is.

  ipcMain.on("avatar-clicked", () => {
    toggleChatWindow();
  });

  ipcMain.on("avatar-zoom", (_event, direction: 1 | -1) => {
    zoomAvatar(direction);
  });

  ipcMain.on("avatar-set-scale", (_event, scale: number) => {
    applyAvatarScale(scale);
  });

  ipcMain.handle("get-avatar-scale", () => settings.avatarScale);

  ipcMain.on("avatar-context-menu", () => {
    showAvatarContextMenu();
  });

  ipcMain.on("avatar-toggle-tts", () => {
    toggleTts();
  });

  ipcMain.handle("get-tts-state", () => ttsStateLabel());

  ipcMain.on("avatar-toggle-history", () => {
    toggleHistoryWindow();
  });

  ipcMain.handle("get-history", () => loadHistory());

  ipcMain.on("avatar-toggle-cost-tracking", () => {
    toggleCostTrackingWindow();
  });

  ipcMain.handle("get-cost-tracking", () => getDailyCostHistory());
  ipcMain.handle("get-search-quota", () => getSearchQuotaStatus());

  ipcMain.on("avatar-toggle-screenview", () => {
    toggleScreenView();
  });

  ipcMain.handle("get-screenview-state", () => screenViewEnabled);

  ipcMain.on("avatar-set-provider", (_event, name: ProviderName) => {
    if (PROVIDER_OPTIONS.includes(name)) setProvider(name);
  });

  ipcMain.handle("get-provider-state", () => activeProvider);

  ipcMain.handle("get-dreaming-state", () => isDreaming);

  ipcMain.handle("get-server-info", () => ({ localUrl: getLanUrl(), token: getOrCreateApiToken() }));

  ipcMain.on("copy-to-clipboard", (_event, text: string) => {
    clipboard.writeText(text);
  });

  // Shared by the desktop chat window (via this IPC handler) and the phone
  // app (via the HTTP API below) - see chat-service.ts. Both drive the exact
  // same logic, so a message from either surface makes the avatar react
  // identically and updates the same history/memory state.
  const handleUserMessage = createChatService({
    getActiveAssistant,
    getActiveProviderName: () => activeProvider,
    conversationSession,
    tts,
    isDreaming: () => isDreaming,
    isScreenViewEnabled: () => screenViewEnabled,
    onStateChange: (state) => avatarWindow?.webContents.send("set-state", state),
    // Only mobile-sourced turns actually need forwarding here - a turn this
    // same window originated is already rendered locally from its own IPC
    // round trip (see chat.ts), so re-sending it would just duplicate it.
    onTurnAppended: (turn) => {
      if (turn.source === "mobile") chatWindow?.webContents.send("chat-turn", turn);
    },
  });

  ipcMain.handle("send-message", (_event, text: string) => handleUserMessage(text, "desktop"));

  startHttpServer(handleUserMessage, { state: ttsStateLabel, toggle: toggleTts }, {
    get: () => activeProvider,
    options: PROVIDER_OPTIONS,
    set: (name) => {
      if (!(PROVIDER_OPTIONS as string[]).includes(name)) return false;
      setProvider(name as ProviderName);
      return true;
    },
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  tts.stop();
  recordAppStop();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Overlay app: stay alive in the tray even if windows are hidden/closed.
});
