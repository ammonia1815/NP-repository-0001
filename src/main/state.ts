import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

// Which client the user sent a turn from - lets each chat surface show
// where the other half of a cross-device conversation came from, and lets
// the desktop chat window skip re-rendering turns it already drew locally.
export type TurnSource = "desktop" | "mobile";

// Which LLM backend actually produced an assistant turn - lets the history
// UI show which model answered (the user switches between these via the
// tray/provider toggle, so a long conversation can span several) and lets NP
// herself be told which one she currently is, the same way TurnSource lets
// her know desktop vs mobile.
// "gemini-fast" is the same Gemini model/persona as "gemini", but built
// around a single cached call using Gemini's own built-in search (instead of
// the custom web_search function tool "gemini" uses to drive a visible
// searching animation) - cheaper and faster per search-needing turn, at the
// cost of the avatar never showing a distinct "searching" state for it
// (falls back to the generic "thinking" clip the whole time, same as before
// explicit caching existed at all).
export type ModelProvider = "gemini" | "gemini-fast" | "claude" | "local";

export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  emotion?: string;
  timestamp: number;
  source?: TurnSource;
  // Only ever set on an "assistant" turn - which provider generated it.
  model?: ModelProvider;
  // Only ever set on a "user" turn - whether this message included photos the
  // phone app's user attached from their gallery, or a desktop screen capture
  // (screen-view mode), respectively. Lets the chat/history windows show a
  // small icon marking which turns actually carried images and of which kind.
  hasPhotoAttachment?: boolean;
  hasScreenView?: boolean;
}

export interface LastDreamInfo {
  ranAt: number;
  shortTermCount: number;
  longTermCount: number;
}

export interface Settings {
  avatarScale: number;
  lastStoppedAt?: number;
  // Timestamp of the newest turn already folded into long-term memory by a
  // "dream" cycle (see longterm.ts). Any stored turn newer than this is the
  // undreamed backlog. 0 until the first dream ever runs.
  lastDreamedAt?: number;
  // Distinct from lastDreamedAt above: that's the timestamp of the newest
  // conversation *content* covered by the last dream, which can be well in
  // the past if the dream processed an old idle stretch - this is the real
  // wall-clock moment the dream cycle itself last actually ran, which is
  // what the AI needs to honestly answer "when did you last dream?".
  lastDreamInfo?: LastDreamInfo;
  // Wall-clock cooldown for the "getting sleepy" ambient hint (see
  // longterm.ts's shouldMentionSleepiness) - real elapsed minutes since it
  // was last shown, independent of conversation activity, since during a
  // long continuous chat the idle-gap-based approach used elsewhere would
  // never re-trigger on its own.
  lastSleepyHintAt?: number;
  // Bearer token the phone app authenticates HTTP API requests with (see
  // auth.ts). Generated once on first run and reused thereafter - rotating
  // it would require re-entering it on every paired device.
  apiToken?: string;
}

const DEFAULT_SETTINGS: Settings = { avatarScale: 1, lastDreamedAt: 0 };

// Cap how many turns we keep on disk, purely as a safety net against
// unbounded growth (e.g. some future bug spamming turns forever) - NOT tied
// to the dream/long-term-memory system's own thresholds (watches from 200,
// force-triggers at 500), since getBacklog() only ever reads turns newer
// than lastDreamedAt regardless of how large this history grows. Raised from
// 700 (which at real usage pace - ~100 turns/day - only covered about a
// week) to comfortably outlast a year of normal use: at that same pace this
// is ~500 days, and even then the file is only tens of MB, trivial for a
// local JSON file to load. This is deliberately just "big enough to never
// matter in practice" rather than unbounded, so a genuine runaway bug still
// can't grow the file without limit.
const MAX_STORED_TURNS = 50000;

function getHistoryPath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "history.json");
}

function getSettingsPath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "settings.json");
}

export function loadSettings(): Settings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

export function loadHistory(): StoredTurn[] {
  try {
    const raw = fs.readFileSync(getHistoryPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function appendHistory(turn: StoredTurn): void {
  const history = loadHistory();
  history.push(turn);
  const trimmed = history.slice(-MAX_STORED_TURNS);
  fs.writeFileSync(getHistoryPath(), JSON.stringify(trimmed, null, 2), "utf-8");
}

// Reads whatever the previous run last recorded as its shutdown time, before anything in
// this run has a chance to overwrite it - lets the AI be told how long it was turned off.
// Returns null if this is the first run ever, or the previous run never recorded a clean
// shutdown (e.g. it crashed or was force-killed).
export function getPreviousStopTimestamp(): number | null {
  return loadSettings().lastStoppedAt ?? null;
}

export function recordAppStop(): void {
  const settings = loadSettings();
  settings.lastStoppedAt = Date.now();
  saveSettings(settings);
}

export function getLastDreamedAt(): number {
  return loadSettings().lastDreamedAt ?? 0;
}

export function setLastDreamedAt(timestamp: number): void {
  const settings = loadSettings();
  settings.lastDreamedAt = timestamp;
  saveSettings(settings);
}

export function getLastDreamInfo(): LastDreamInfo | null {
  return loadSettings().lastDreamInfo ?? null;
}

export function setLastDreamInfo(info: LastDreamInfo): void {
  const settings = loadSettings();
  settings.lastDreamInfo = info;
  saveSettings(settings);
}

export function getLastSleepyHintAt(): number {
  return loadSettings().lastSleepyHintAt ?? 0;
}

export function setLastSleepyHintAt(timestamp: number): void {
  const settings = loadSettings();
  settings.lastSleepyHintAt = timestamp;
  saveSettings(settings);
}
