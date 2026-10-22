import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "./config";
import {
  loadHistory,
  StoredTurn,
  getLastDreamedAt,
  setLastDreamedAt,
  setLastDreamInfo,
  getLastSleepyHintAt,
  setLastSleepyHintAt,
} from "./state";
import { embedText, embedTexts, cosineSimilarity, embeddingModelName } from "./embeddings";
import { loadUserProfile, saveUserProfile } from "./userprofile";

// See 엔피_장기기억(꿈)_기능_계획.md for the full design this implements.

export type MemoryCategory = "short_term" | "long_term";

export interface LongTermMemoryEntry {
  id: string;
  category: MemoryCategory;
  text: string;
  embedding: number[] | null;
  embeddingModel: string;
  periodStart: string;
  periodEnd: string;
  createdAt: number;
  // Exact timestamp of whichever source turn (within this entry's own dream
  // session) this fact's embedding most closely matches - null if no match
  // could be made (e.g. embedding failed). Lets recall_original_conversation
  // jump straight to the real turns a summary was distilled from, instead of
  // only knowing the day it happened. For entries that existed before this
  // field was added, a one-off backfill script (not part of the app itself)
  // populated this the same way, just searching a wider date window since
  // the exact source session wasn't recorded for those - see
  // 구글 로그 추출/장기기억_타임스탬프_백필_검토용.json for that one-time pass.
  sourceTimestamp: number | null;
  // Cosine similarity of this entry's own embedding against its matched
  // source turn - recall_original_conversation treats anything below
  // RECALL_MATCH_THRESHOLD as untrustworthy and refuses to guess rather than
  // risk surfacing the wrong conversation as if it were certain.
  sourceMatchScore: number | null;
}

export interface MemoryCandidate {
  text: string;
  timestamp: number;
  // Only present for a candidate backed by an actual long_term_memory.json
  // entry (not a raw recent-backlog turn, which is already shown in full
  // elsewhere and has nothing to "recall" further) - lets
  // recall_original_conversation resolve exactly which entry an index into
  // this list refers to.
  id?: string;
  sourceTimestamp?: number | null;
}

// Watching for a dream opportunity starts once this many turns have piled up
// since the last dream, and never fires below it - this is what stops a
// "dream" from running over a trivially small amount of new conversation.
const WATCH_THRESHOLD = 200;
// Past this backlog size, the safety valve kicks in: required idle time drops
// sharply so a dream is far more likely to sneak into even a short pause,
// rather than risk the 700-turn storage cap evicting undreamed history.
const FORCE_THRESHOLD = 500;
const NORMAL_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
const FORCE_IDLE_MS = 5 * 60 * 1000; // 5 minutes

// A gap of at least this long between two consecutive backlog turns marks a
// new "session" boundary for splitIntoSessions() below - unrelated to
// NORMAL_IDLE_MS/FORCE_IDLE_MS above, which decide *when* a dream is allowed
// to run at all, not how its backlog gets chopped up once it does.
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

function getLongTermPath(): string {
  return path.join(app.getPath("userData"), "long_term_memory.json");
}

// loadLongTermMemories() used to re-read and re-parse the whole file from
// disk on every single call - and findSemanticMemories() calls it on every
// chat message. That was fine at a couple hundred entries, but the file is
// dominated by embedding vectors (3072 floats each, ~60KB/entry as JSON) and
// only ever changes when a dream or backfill writes to it - every message in
// between was redundant disk I/O + JSON parsing of a file nothing had
// touched. This cache keeps the parsed array in memory and only re-reads
// when the file's own mtime has actually moved (checked via a cheap stat()
// call, not by re-reading content), so it stays correct even if the file is
// ever touched by something other than saveLongTermMemories below.
let cachedEntries: LongTermMemoryEntry[] | null = null;
let cachedMtimeMs: number | null = null;

function loadLongTermMemories(): LongTermMemoryEntry[] {
  const filePath = getLongTermPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    cachedEntries = [];
    cachedMtimeMs = null;
    return cachedEntries;
  }

  if (cachedEntries !== null && cachedMtimeMs === mtimeMs) {
    return cachedEntries;
  }

  try {
    cachedEntries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    cachedEntries = [];
  }
  cachedMtimeMs = mtimeMs;
  return cachedEntries!;
}

function saveLongTermMemories(entries: LongTermMemoryEntry[]): void {
  fs.mkdirSync(path.dirname(getLongTermPath()), { recursive: true });
  fs.writeFileSync(getLongTermPath(), JSON.stringify(entries, null, 2), "utf-8");
  // Updated immediately rather than left for the next load() to discover via
  // stat() - avoids a window where a read right after this write would still
  // need to touch disk at all.
  cachedEntries = entries;
  try {
    cachedMtimeMs = fs.statSync(getLongTermPath()).mtimeMs;
  } catch {
    cachedMtimeMs = null;
  }
}

// Everything appended since the last dream - the raw material a dream cycle
// consumes, and (until it's dreamed) still fully visible to the 📅 history
// viewer and, via the in-memory cache below, to semantic search too.
function getBacklog(): StoredTurn[] {
  const lastDreamedAt = getLastDreamedAt();
  return loadHistory().filter((t) => t.timestamp > lastDreamedAt);
}

export function isDreamOpportunity(): boolean {
  const backlog = getBacklog();
  if (backlog.length < WATCH_THRESHOLD) return false;

  const idleMs = Date.now() - backlog[backlog.length - 1].timestamp;
  const requiredIdleMs = backlog.length >= FORCE_THRESHOLD ? FORCE_IDLE_MS : NORMAL_IDLE_MS;
  return idleMs >= requiredIdleMs;
}

// Middle of the user-specified 30~60 minute range for how often the
// "getting sleepy" ambient hint is allowed to re-surface once backlog has
// crossed WATCH_THRESHOLD. A wall-clock cooldown (not an idle-gap check like
// the health review's) because the whole point is to still mention it
// occasionally even during one long, unbroken, active conversation.
const SLEEPY_HINT_COOLDOWN_MS = 45 * 60 * 1000;

export interface SleepinessStatus {
  waiting: boolean;
  backlogSize: number;
}

// Called once per message while building ambient context - this both checks
// and (when it fires) immediately updates the cooldown, so it's meant to be
// called at most once per real message, not speculatively.
export function checkSleepiness(): SleepinessStatus {
  const backlogSize = getBacklog().length;
  if (backlogSize < WATCH_THRESHOLD) {
    return { waiting: false, backlogSize };
  }

  const sinceLastHint = Date.now() - getLastSleepyHintAt();
  if (sinceLastHint < SLEEPY_HINT_COOLDOWN_MS) {
    return { waiting: false, backlogSize };
  }

  setLastSleepyHintAt(Date.now());
  return { waiting: true, backlogSize };
}

interface DreamClassificationResult {
  short_term?: string[];
  long_term?: string[];
}

const DREAM_SCHEMA = {
  type: "object",
  properties: {
    short_term: { type: "array", items: { type: "string" } },
    long_term: { type: "array", items: { type: "string" } },
  },
  required: ["short_term", "long_term"],
  additionalProperties: false,
};

// A single classifyBacklog() call over many days of mixed-topic backlog at
// once made it easy for the model to skim past a specific detail buried in
// the middle (the exact failure mode behind the 윤진석/말레이곰 stat-recall
// bug: the correction lived in one short exchange within a much larger,
// unrelated backlog and got missed). Splitting into per-session chunks - each
// classified with its own dedicated call - keeps each individual prompt
// focused, at the cost of one Gemini call per session instead of one per
// dream cycle.
function splitIntoSessions(backlog: StoredTurn[]): StoredTurn[][] {
  if (backlog.length === 0) return [];
  const sessions: StoredTurn[][] = [[backlog[0]]];
  for (let i = 1; i < backlog.length; i++) {
    const gap = backlog[i].timestamp - backlog[i - 1].timestamp;
    if (gap >= SESSION_GAP_MS) {
      sessions.push([]);
    }
    sessions[sessions.length - 1].push(backlog[i]);
  }
  return sessions;
}

function formatTranscript(backlog: StoredTurn[]): string {
  return backlog
    .map((t) => {
      const label = new Date(t.timestamp).toLocaleString("ko-KR");
      return `[${label}] ${t.role === "user" ? "사용자" : "엔피"}: ${t.text}`;
    })
    .join("\n");
}

// Classification always goes through Gemini regardless of which provider is
// live for chat right now (the provider toggle) - this keeps the dream
// pipeline self-contained and independent of that runtime switch.
//
// Each dream cycle used to classify its backlog window in isolation, with no
// idea what earlier cycles had already saved - a real case was found where
// the same hotel fact got re-extracted four times across separate cycles,
// each with slightly different wording, and embedding-similarity dedup at
// read time couldn't reliably catch it (differently-worded restatements of
// the same fact scored as low as 0.83 cosine similarity, well under any
// safe dedup threshold). Showing the existing fact list up front and asking
// the model to skip anything already covered fixes this at the source.
async function classifyBacklog(backlog: StoredTurn[]): Promise<DreamClassificationResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const existingFacts = loadLongTermMemories().map((e) => e.text);
  const existingFactsBlock =
    existingFacts.length > 0
      ? `\n\n이미 저장되어 있는 기존 사실 목록 (아래와 같거나 표현만 다른 같은 내용은 절대 다시 추출하지 마세요):\n${existingFacts.map((f) => `- ${f}`).join("\n")}`
      : "";

  const prompt = `아래는 AI 비서 "엔피"와 사용자가 나눈 대화 원문입니다. 앞으로도 기억할 가치가 있는 내용을 뽑아 분류해주세요.

- short_term: 아직 세부 맥락이 중요할 수 있는, 비교적 최근의 사건/맥락 (독립적인 한 문장씩)
- long_term: 오래 남길 가치가 있는 사실, 취향, 반복되는 패턴 (독립적인 한 문장씩)
- 단순 잡담이나 사소한 내용은 어느 쪽에도 넣지 말고 버리세요. 있는 그대로의 사실만 적고, 추측하지 마세요.
- 이미 아는 사실을 표현만 바꿔서 다시 추출하지 마세요. 완전히 새롭거나, 기존 내용과 명확히 달라진 정보만 추출하세요.
- 대화 중 엔피가 "제가 잘못 판단했습니다" 등으로 스스로 앞선 답변을 정정한 부분이 있다면, 그 정정으로 새로 확정된 최종 정보(사람/캐릭터의 신체 스펙, 능력치처럼 이후에도 다시 물어볼 만한 구체적 사실 등)는 사소해 보이더라도 반드시 long_term으로 남기세요 - 다음 대화에서 같은 실수를 반복하지 않도록 하기 위함입니다.${existingFactsBlock}

대화 원문:
${formatTranscript(backlog)}`;

  try {
    const client = new GoogleGenAI({ apiKey });
    const config = loadConfig();
    const interaction = await client.interactions.create({
      model: config.geminiModel,
      input: prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: DREAM_SCHEMA,
      },
    });
    return JSON.parse(interaction.output_text ?? "{}") as DreamClassificationResult;
  } catch (err) {
    console.error("Dream classification failed:", err);
    return null;
  }
}

// Rewrites the always-on "주인 프로필" persona block (see userprofile.ts) only
// if the backlog contains a durable, clearly-confirmed fact about the user
// that isn't already reflected in it - an explicit instruction to return the
// file unchanged otherwise, so this can't silently bloat or duplicate on
// every dream cycle. Runs on the same cadence as the dream cycle itself
// (i.e. only when there's an idle opportunity), never as a live chat tool.
async function updateUserProfileFromBacklog(backlog: StoredTurn[]): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const currentProfile = loadUserProfile();
  if (currentProfile === null) return;

  const prompt = `아래는 AI 비서 "엔피"가 주인님에 대해 항상 참조하는 프로필 파일의 현재 내용과, 최근 나눈 대화 원문입니다.

현재 프로필 파일:
---
${currentProfile}
---

최근 대화 원문:
${formatTranscript(backlog)}

이 대화에서 주인님에 대해 새롭게 확인되었거나 기존 내용과 달라진, 확실하고 반복적으로
확인되는 정보가 있다면 프로필 파일에 자연스럽게 통합해서 파일 전체를 다시 작성하세요.

규칙:
- 이미 프로필에 있는 내용과 중복되지 않도록 통합하세요 (같은 사실을 또 추가하지 마세요).
- 여행 일정, 특정 날짜의 근무 변경 등 일시적인 사건은 절대 넣지 마세요.
- 추측하지 말고, 대화에서 명확하게 확인된 사실만 반영하세요.
- 반영할 변경 사항이 전혀 없다면, 프로필 파일 내용을 한 글자도 바꾸지 말고 그대로 반환하세요.
- 파일의 기존 마크다운 구조(제목, 섹션)를 유지하세요.
- 출력에는 프로필 파일 전체 내용만 담고, 다른 설명은 절대 덧붙이지 마세요.`;

  try {
    const client = new GoogleGenAI({ apiKey });
    const config = loadConfig();
    const interaction = await client.interactions.create({
      model: config.geminiModel,
      input: prompt,
    });
    const updated = (interaction.output_text ?? "").trim();
    if (!updated || updated === currentProfile.trim()) return;
    saveUserProfile(updated);
  } catch (err) {
    console.error("User profile update failed:", err);
  }
}

// Runs one full dream cycle: split the backlog into per-session chunks (see
// splitIntoSessions above), classify and save each session's results one at a
// time, and advance the watermark after each session succeeds - rather than
// once at the very end - so a later session's transient classification
// failure doesn't force already-saved earlier sessions to be redone next
// time. classifyBacklog() re-reads long_term_memory.json fresh on every call,
// so saving immediately after each session also means the next session's
// dedup check already sees this cycle's own freshly-added facts, not just
// whatever existed before the cycle started.
export async function runDream(): Promise<void> {
  const backlog = getBacklog();
  if (backlog.length === 0) return;

  await updateUserProfileFromBacklog(backlog);

  const sessions = splitIntoSessions(backlog);
  let totalShortTerm = 0;
  let totalLongTerm = 0;
  let anySucceeded = false;

  for (const session of sessions) {
    const result = await classifyBacklog(session);
    if (!result) break;

    const lastTimestamp = session[session.length - 1].timestamp;
    const periodStart = new Date(session[0].timestamp).toISOString().slice(0, 10);
    const periodEnd = new Date(lastTimestamp).toISOString().slice(0, 10);

    const items: { category: MemoryCategory; text: string }[] = [
      ...(result.short_term ?? []).map((text) => ({ category: "short_term" as const, text })),
      ...(result.long_term ?? []).map((text) => ({ category: "long_term" as const, text })),
    ].filter((item) => item.text.trim().length > 0);

    totalShortTerm += (result.short_term ?? []).filter((t) => t.trim().length > 0).length;
    totalLongTerm += (result.long_term ?? []).filter((t) => t.trim().length > 0).length;

    if (items.length > 0) {
      const vectors = await embedTexts(items.map((i) => i.text));

      // Unlike the one-off backfill (which had to guess a multi-day window
      // since old entries never recorded which exact session produced
      // them), a fresh dream already knows precisely which turns (`session`)
      // it's summarizing - so this only ever needs to search within that
      // one small, known batch, which is both cheaper and more reliable
      // than the backfill's wider search ever could be. Reuses
      // backlogEmbeddingCache where possible (warmed after every message)
      // instead of re-embedding turns that likely already have a vector.
      const sessionVectors = await Promise.all(
        session.map(async (t) => backlogEmbeddingCache.get(t.timestamp) ?? (await embedText(t.text)))
      );

      function matchSourceTurn(itemVector: number[] | null): { timestamp: number | null; score: number | null } {
        if (!itemVector) return { timestamp: null, score: null };
        let bestIdx = -1;
        let bestScore = -1;
        session.forEach((_, i) => {
          const v = sessionVectors[i];
          if (!v) return;
          const score = cosineSimilarity(itemVector, v);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        });
        if (bestIdx === -1) return { timestamp: null, score: null };
        return { timestamp: session[bestIdx].timestamp, score: Math.round(bestScore * 1000) / 1000 };
      }

      const newEntries: LongTermMemoryEntry[] = items.map((item, i) => {
        const { timestamp: sourceTimestamp, score: sourceMatchScore } = matchSourceTurn(vectors[i]);
        return {
          id: `${lastTimestamp}_${i}`,
          category: item.category,
          text: item.text,
          embedding: vectors[i],
          embeddingModel: embeddingModelName(),
          periodStart,
          periodEnd,
          createdAt: Date.now(),
          sourceTimestamp,
          sourceMatchScore,
        };
      });
      saveLongTermMemories([...loadLongTermMemories(), ...newEntries]);
    }

    // Advanced after each session is safely written, so a crash or failure
    // partway through a multi-session dream can't lose sessions that already
    // succeeded.
    anySucceeded = true;
    setLastDreamedAt(lastTimestamp);
  }

  // Recorded regardless of whether anything was actually kept, so the AI can
  // honestly say a dream happened even on a run that decided everything was
  // forgettable - not just infer it from long_term_memory.json entries that
  // might not exist. Skipped entirely if every session failed outright
  // (e.g. no API key), matching the old all-or-nothing behavior for that case.
  if (anySucceeded) {
    setLastDreamInfo({ ranAt: Date.now(), shortTermCount: totalShortTerm, longTermCount: totalLongTerm });
  }
}

// A dream that classifies successfully but hits a transient embedding
// failure (network blip, API hiccup) still saves its entries with
// embedding: null rather than losing the classified text - but a null
// embedding is permanently invisible to findSemanticMemories, so this
// periodically retries just the embedding step for anything still missing
// one. Cheap no-op when there's nothing to backfill.
export async function backfillMissingEmbeddings(): Promise<void> {
  const entries = loadLongTermMemories();
  const missing = entries.filter((e) => !e.embedding);
  if (missing.length === 0) return;

  const vectors = await embedTexts(missing.map((e) => e.text));
  let vi = 0;
  const updated = entries.map((e) => {
    if (e.embedding) return e;
    const v = vectors[vi];
    vi++;
    return v ? { ...e, embedding: v, embeddingModel: embeddingModelName() } : e;
  });
  saveLongTermMemories(updated);
}

// Undreamed backlog turns aren't persisted with embeddings anywhere (they're
// transient - either they get dreamed into long_term_memory.json eventually,
// or they aren't important enough to matter) so this in-memory-only cache is
// warmed opportunistically after each message, never blocking the reply
// itself. Skipped/never-warmed turns just don't show up in semantic search
// until the next warm - the raw text is still visible via the recent-session
// window and the 📅 viewer regardless.
const backlogEmbeddingCache = new Map<number, number[]>();

export async function warmBacklogEmbeddingCache(): Promise<void> {
  const backlog = getBacklog();
  const uncached = backlog.filter((t) => !backlogEmbeddingCache.has(t.timestamp));

  const validTimestamps = new Set(backlog.map((t) => t.timestamp));
  for (const key of backlogEmbeddingCache.keys()) {
    if (!validTimestamps.has(key)) backlogEmbeddingCache.delete(key);
  }

  if (uncached.length === 0) return;
  const vectors = await embedTexts(uncached.map((t) => t.text));
  uncached.forEach((t, i) => {
    const v = vectors[i];
    if (v) backlogEmbeddingCache.set(t.timestamp, v);
  });
}

// Pure cosine similarity has no notion of "this happened recently" or "this
// literally contains the word you just said" - both of which a human would
// weigh heavily. A real mis-retrieval was observed (an old-but-textually-
// similar memory outranking the actually-intended recent one for a
// low-content query), so ranking now blends three signals instead of one.

// Half-life for the recency bonus: a memory from "just now" gets the full
// bonus, one from two weeks ago gets half of it, decaying smoothly rather
// than a hard cutoff window.
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Kept small relative to typical cosine-similarity spread so recency/keyword
// signals nudge the ranking rather than override genuine semantic relevance.
const RECENCY_WEIGHT = 0.15;
const KEYWORD_BOOST_PER_TOKEN = 0.15;
const KEYWORD_BOOST_CAP = 0.3;

function recencyBonus(timestamp: number, referenceTime: number): number {
  const ageMs = Math.max(0, referenceTime - timestamp);
  return RECENCY_WEIGHT * Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
}

// Deliberately crude (whitespace/punctuation split, no stemming) - only
// applied to the QUERY, to pull out candidate keywords like a place name or
// game title. Korean words carry topic/case particles glued on with no
// space (e.g. "숙소는", "호텔에서"), so a bare word from the query will very
// often NOT appear as its own token inside a candidate's tokenized text -
// substring containment (see keywordBoost) is used on the candidate side
// instead of a second tokenize-and-set-intersect pass.
function extractKeywordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,./~()·"'\[\]{}:;!?]+/)
      .filter((w) => w.length >= 2)
  );
}

function keywordBoost(queryTokens: Set<string>, text: string): number {
  const lower = text.toLowerCase();
  let overlap = 0;
  for (const t of queryTokens) {
    if (lower.includes(t)) overlap++;
  }
  return Math.min(KEYWORD_BOOST_CAP, overlap * KEYWORD_BOOST_PER_TOKEN);
}

// Detects explicit relative-time language in the query ("어제", "오늘", "자기
//전") and maps it to a concrete timestamp window, boosted heavily below -
// added after a real miss: asking "자기 전에 어디까지 했어" failed to surface
// a conversation from 01:13 that same day, because nothing in the query text
// overlapped the actual content ("136턴", "8~9개 도시" etc.) semantically or
// lexically. Cosine similarity and keyword overlap have no notion of "the
// thing I'm asking about happened at a specific time", even though the user
// very often states that time explicitly.
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface TimeWindow {
  start: number;
  end: number;
  // The dawn-reference window below is deliberately wide (36h) to straddle
  // midnight regardless of which side "last night" fell on - restricting it
  // to night-clock-hours only is what keeps it from also boosting an
  // unrelated daytime message that happens to fall in the same 36h span.
  requireNightHour: boolean;
  // Set when the query itself names a clock hour ("새벽 1시") - narrows the
  // match to near that hour-of-day instead of the whole window, which is what
  // actually distinguishes "1시" from "3시" within the same night.
  targetHour?: number;
}

const RELATIVE_DAY_PATTERNS: { pattern: RegExp; dayOffset: number }[] = [
  { pattern: /그제|그저께/, dayOffset: -2 },
  { pattern: /어제|엊그제|엊저녁/, dayOffset: -1 },
  { pattern: /오늘|방금|아까/, dayOffset: 0 },
];

// "새벽" (dawn) has the same no-fixed-calendar-day problem as "자기 전"/"잠들기
// 전"/"취침 전" - all of them mean "the most recent night", confirmed for
// real as a miss: "대충 새벽 1시 쯤이야" wasn't recognized at all by an
// earlier version of this pattern that only covered "자기 전" wording.
const DAWN_REFERENCE_PATTERN = /새벽|자기\s*전|잠들기\s*전|취침\s*전/;

// Matches "1시", "01시", "새벽 1시" etc. - excludes "시간" (a duration unit,
// not a clock hour) via the negative lookahead, so "3시간 걸렸어" doesn't
// misparse as "3 o'clock".
const HOUR_MENTION_PATTERN = /(\d{1,2})\s*시(?!간)/;

function extractHourMention(query: string): number | undefined {
  const m = query.match(HOUR_MENTION_PATTERN);
  if (!m) return undefined;
  const h = parseInt(m[1], 10);
  return h >= 0 && h <= 23 ? h : undefined;
}

function getTimeReferenceWindows(query: string, now: number): TimeWindow[] {
  const windows: TimeWindow[] = [];
  const explicitHour = extractHourMention(query);
  let dayWindowAdded = false;

  for (const { pattern, dayOffset } of RELATIVE_DAY_PATTERNS) {
    if (pattern.test(query)) {
      const dayStart = startOfLocalDay(now) + dayOffset * DAY_MS;
      windows.push({ start: dayStart, end: dayStart + DAY_MS, requireNightHour: false, targetHour: explicitHour });
      dayWindowAdded = true;
      break; // most specific match wins rather than stacking multiple days
    }
  }

  if (DAWN_REFERENCE_PATTERN.test(query)) {
    windows.push({ start: now - 36 * 60 * 60 * 1000, end: now, requireNightHour: true, targetHour: explicitHour });
  } else if (explicitHour !== undefined && !dayWindowAdded) {
    // An hour mentioned with no day/dawn anchor at all ("3시쯤에 그거 했잖아")
    // still deserves a lighter-touch window: the most recent occurrence of
    // that hour, not restricted to night.
    windows.push({ start: now - 48 * 60 * 60 * 1000, end: now, requireNightHour: false, targetHour: explicitHour });
  }

  return windows;
}

function isNightHour(ts: number): boolean {
  const hour = new Date(ts).getHours();
  return hour >= 20 || hour < 7;
}

// Wraps around midnight (23:00 vs 01:00 is 2h apart, not 22h) so an hour
// mention near the day boundary doesn't get unfairly penalized.
function matchesHourOfDay(ts: number, targetHour: number, toleranceHours = 1.5): boolean {
  const d = new Date(ts);
  const hourFraction = d.getHours() + d.getMinutes() / 60;
  const diff = Math.abs(hourFraction - targetHour);
  return Math.min(diff, 24 - diff) <= toleranceHours;
}

// Large relative to RECENCY_WEIGHT/KEYWORD_BOOST_CAP above - an explicit time
// reference in the question is a much stronger signal than either of those,
// and should be able to pull in a candidate that pure semantic similarity
// ranked low.
const TIME_PHRASE_BOOST = 0.5;

function timeReferenceBoost(windows: TimeWindow[], timestamp: number): number {
  for (const w of windows) {
    if (timestamp < w.start || timestamp > w.end) continue;
    if (w.requireNightHour && !isNightHour(timestamp)) continue;
    if (w.targetHour !== undefined && !matchesHourOfDay(timestamp, w.targetHour)) continue;
    return TIME_PHRASE_BOOST;
  }
  return 0;
}

// Replaces the old pure-cosine ranking: embeds the query once and ranks it
// against both permanent long-term memories and whatever undreamed backlog
// has been embedded so far, so nothing goes dark between being written and
// being dreamed. `beforeTimestamp` excludes anything from the current
// session, which the caller already includes in full via its own recent-turns
// window. Final ranking blends semantic similarity with a recency bonus and a
// verbatim-keyword-overlap bonus (see comment above) rather than similarity alone.
// Repeated dream cycles can independently re-classify overlapping backlog
// windows into near-identical restatements of the same fact (observed for
// real: "숙소는 루미 호텔..." saved four times with slightly different
// wording). Left unfiltered, those near-duplicates cluster at the top of the
// ranking and crowd out genuinely distinct facts, so a topK of even 10-20
// can still surface the same fact repeated. Skips a candidate whenever it's
// too semantically close to one already selected, rather than deduplicating
// by exact text match.
const DIVERSITY_SIMILARITY_THRESHOLD = 0.93;

interface ScoredCandidate {
  text: string;
  timestamp: number;
  score: number;
  embedding: number[];
  id?: string;
  sourceTimestamp?: number | null;
}

export async function findSemanticMemories(
  query: string,
  beforeTimestamp: number,
  topK = 10
): Promise<MemoryCandidate[]> {
  const queryVector = await embedText(query);
  if (!queryVector) return [];

  const queryTokens = extractKeywordTokens(query);
  const now = Date.now();
  const timeWindows = getTimeReferenceWindows(query, now);

  // Note: NOT filtered by beforeTimestamp. That cutoff exists to avoid
  // showing raw backlog turns that the caller already includes in full via
  // its own "recent session turns" block (see backlogScored below) - it
  // does NOT mean "ignore memories created during this session". A
  // long-term entry's createdAt is when some dream cycle (or a manual
  // maintenance pass) distilled it, which can happen at any point during an
  // arbitrarily long-running session and has no relation to whether its
  // *content* overlaps the current session's own turns. A real bug was
  // found where entries created by a mid-session cleanup pass were then
  // invisible to every query for the rest of that (long-running) session,
  // because their createdAt fell after the fixed sessionStart cutoff.
  const longTermScored: ScoredCandidate[] = loadLongTermMemories()
    .filter((e) => e.embedding)
    .map((e) => ({
      text: e.text,
      timestamp: e.createdAt,
      embedding: e.embedding!,
      id: e.id,
      sourceTimestamp: e.sourceTimestamp,
      score:
        cosineSimilarity(queryVector, e.embedding!) +
        recencyBonus(e.createdAt, now) +
        keywordBoost(queryTokens, e.text) +
        // createdAt is when the dream ran, not when the fact actually
        // happened - sourceTimestamp (when matched with confidence) is the
        // real event time, which is what a time-phrase like "어제" refers to.
        timeReferenceBoost(timeWindows, e.sourceTimestamp ?? e.createdAt),
    }));

  const backlogScored: ScoredCandidate[] = getBacklog()
    .filter((t) => t.timestamp < beforeTimestamp && backlogEmbeddingCache.has(t.timestamp))
    .map((t) => ({
      text: t.text,
      timestamp: t.timestamp,
      embedding: backlogEmbeddingCache.get(t.timestamp)!,
      score:
        cosineSimilarity(queryVector, backlogEmbeddingCache.get(t.timestamp)!) +
        recencyBonus(t.timestamp, now) +
        keywordBoost(queryTokens, t.text) +
        timeReferenceBoost(timeWindows, t.timestamp),
    }));

  const ranked = [...longTermScored, ...backlogScored].sort((a, b) => b.score - a.score);

  const selected: ScoredCandidate[] = [];
  for (const candidate of ranked) {
    if (selected.length >= topK) break;
    const tooSimilarToSelected = selected.some(
      (s) => cosineSimilarity(candidate.embedding, s.embedding) > DIVERSITY_SIMILARITY_THRESHOLD
    );
    if (tooSimilarToSelected) continue;
    selected.push(candidate);
  }

  return selected.map((s) => ({ text: s.text, timestamp: s.timestamp, id: s.id, sourceTimestamp: s.sourceTimestamp }));
}

// Below this, a match is treated as "couldn't actually determine" rather
// than acted on - matches the 0.7 cutoff used when merging the one-off
// backfill into long_term_memory.json (see that script's own review output),
// so a fresh dream's own matches are held to the same bar.
const RECALL_MATCH_THRESHOLD = 0.7;

// How many turns before/after the matched source turn to include - enough
// to show the actual back-and-forth around the fact without dumping an
// unbounded chunk of unrelated conversation.
const RECALL_CONTEXT_TURNS = 5;

function roleLabelFor(role: "user" | "assistant"): string {
  return role === "user" ? "사용자" : "비서(과거의 엔피)";
}

// Looks up one long-term memory entry by id and, if it has a trustworthy
// sourceTimestamp, returns the real conversation turns immediately
// surrounding it - the raw back-and-forth a dream's summary compressed
// away. Returns a clear refusal instead of guessing when the entry has no
// match, or one too weak to trust (see RECALL_MATCH_THRESHOLD) - same
// "admit it rather than fabricate" rule already enforced for search.
export function recallOriginalConversation(entryId: string): string {
  const entry = loadLongTermMemories().find((e) => e.id === entryId);
  if (!entry) return "해당 기억 항목을 찾을 수 없습니다.";
  if (entry.sourceTimestamp === null || entry.sourceMatchScore === null || entry.sourceMatchScore < RECALL_MATCH_THRESHOLD) {
    return "이 기억은 정확히 어느 대화에서 나왔는지 확인하지 못했습니다 - 요약된 내용만 알고 있고, 원본 대화는 찾을 수 없습니다.";
  }

  const history = loadHistory();
  const idx = history.findIndex((t) => t.timestamp === entry.sourceTimestamp);
  if (idx === -1) {
    return "원본 대화 시점은 기록되어 있지만, 해당 턴이 대화 기록에서 삭제되었거나 찾을 수 없습니다.";
  }

  const start = Math.max(0, idx - RECALL_CONTEXT_TURNS);
  const end = Math.min(history.length, idx + RECALL_CONTEXT_TURNS + 1);
  const window = history.slice(start, end);

  const pad = (n: number) => String(n).padStart(2, "0");
  const lines = window.map((t) => {
    const d = new Date(t.timestamp);
    const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const marker = t.timestamp === entry.sourceTimestamp ? " <-- 이 기억이 나온 지점" : "";
    return `[${time}] ${roleLabelFor(t.role)}: ${t.text}${marker}`;
  });

  return `[요약된 기억] ${entry.text}\n\n[원본 대화 전후 ${window.length}턴]\n${lines.join("\n")}`;
}
