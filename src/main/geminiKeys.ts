// Shared Gemini API key pool: lets several keys (e.g. leftover quota from a
// friend's shelved project) be registered as GEMINI_API_KEY, GEMINI_API_KEY_2,
// GEMINI_API_KEY_3, ... in .env, and rotates to the next one automatically
// when the active key's free-tier quota runs out. Both GeminiAssistant
// instances ("gemini" and "gemini-fast") import this SAME module-level state,
// since they hit the same underlying per-key quota and must rotate together -
// if one mode exhausts a key, the other mode's calls would fail on it too.
const MAX_KEYS = 5;

// Placeholder slots in .env (e.g. "GEMINI_API_KEY_4=...") shouldn't be
// treated as real keys - "..." itself is a plausible-looking non-empty
// string, so it needs an explicit skip rather than just a truthiness check.
function isRealKey(value: string | undefined): value is string {
  return !!value && value.trim().length > 0 && value.trim() !== "...";
}

function loadKeys(): string[] {
  const keys: string[] = [];
  if (isRealKey(process.env.GEMINI_API_KEY)) keys.push(process.env.GEMINI_API_KEY!.trim());
  for (let i = 2; i <= MAX_KEYS; i++) {
    const value = process.env[`GEMINI_API_KEY_${i}`];
    if (isRealKey(value)) keys.push(value.trim());
  }
  return keys;
}

// Manual override for which key to start on, 1-based (GEMINI_ACTIVE_KEY_INDEX
// in .env) - lets the user point at a specific key (e.g. "2") without
// relying on automatic rotation, which is currently disabled below while
// they manually cross-check the cost-tracking window's quota numbers against
// Google's own billing each day before trusting it to switch keys on its own.
function loadInitialIndex(keyCount: number): number {
  const raw = parseInt(process.env.GEMINI_ACTIVE_KEY_INDEX ?? "1", 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > keyCount) return 0;
  return raw - 1;
}

// Set to false per explicit request: automatic quota-triggered rotation stays
// wired up (ready to flip back on) but inert for now, while the user
// manually verifies whether the cost-tracking window's quota estimate
// actually matches when Google's real monthly free search quota runs out,
// switching keys by hand (via GEMINI_ACTIVE_KEY_INDEX) in the meantime.
export const AUTO_ROTATE_ON_QUOTA = false;

const keys = loadKeys();
let activeIndex = loadInitialIndex(keys.length);
// Bumped every rotation - GeminiAssistant compares this against the version
// its current client/caches were built for, and rebuilds them if it's stale.
// Caches are scoped to the API key that created them, so a stale cache
// reference under a newly-rotated key would just fail outright otherwise.
let version = 0;

export function hasGeminiKey(): boolean {
  return keys.length > 0;
}

export function getActiveGeminiKey(): string | null {
  return keys[activeIndex] ?? null;
}

export function getKeyVersion(): number {
  return version;
}

export function getKeyStatus(): { activeIndex: number; total: number } {
  return { activeIndex, total: keys.length };
}

// Returns false (and leaves the active key unchanged) once every registered
// key has been tried - callers should surface the real quota error at that
// point instead of retrying forever.
export function rotateToNextGeminiKey(): boolean {
  if (activeIndex >= keys.length - 1) {
    console.error(`[gemini-keys] 마지막 키(${activeIndex + 1}/${keys.length})까지 전부 할당량을 소진했습니다.`);
    return false;
  }
  activeIndex++;
  version++;
  console.warn(`[gemini-keys] 할당량 소진 감지 - 키 ${activeIndex}/${keys.length}로 전환합니다.`);
  return true;
}

// 429 is how Google's API reports both true rate limiting and free-tier
// quota exhaustion - confirmed via the @google/genai SDK's ApiError.status
// field (the only structured signal it exposes; the message text itself
// varies by exact cause, e.g. RESOURCE_EXHAUSTED or per-model rate limits).
export function isQuotaExceededError(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 429) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("RESOURCE_EXHAUSTED") || message.includes("429");
}
