import * as fs from "fs";
import * as path from "path";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "./config";

// Dedicated folder, separate from the read-only "엔피 조회 가능 자료" browser -
// this is the one place the assistant is allowed to write, and only to this
// one structured file, never arbitrary paths.
const DATA_ROOT = path.resolve(__dirname, "..", "..", "엔피 건강관리 데이터");
const PROFILE_PATH = path.join(DATA_ROOT, "user_health_profile.json");

const MAX_LOGS = 500;

export interface RotationRule {
  pattern: string;
  anchor_date: string; // YYYY-MM-DD - this date maps to pattern[0]
  effective_from: string; // YYYY-MM-DD
  effective_until: string | null; // YYYY-MM-DD, null = still open
}

export interface ShiftOverride {
  code: string;
  reason?: string;
}

export type ExerciseType = "aerobic" | "anaerobic" | "mixed";

// 종류: what kind of eating/drinking occasion this was. The user is a shift
// worker, so meal-time labels like "아침"/"야식" are meaningless (the first
// meal of their "day" can land at 4am) - the entry's own time field already
// conveys that, so this classifies the OCCASION instead. 집밥 vs 간편식 is a
// real-vs-reheated-only distinction: actively cooking/heating raw ingredients
// (including from a meal kit, e.g. simmering 명태조림) counts as 집밥, while
// eating something already fully prepared as-is (rotisserie chicken, a wrap)
// counts as 간편식, even though both happen at home.
export type MealType = "집밥" | "외식" | "간편식" | "급식" | "반주" | "간식" | "음료" | "음주" | "기타";

// 평가: a quality/quantity judgment. For food, the model sets this directly
// at log time. For alcohol it works differently (see the cascading logic in
// appendHealthLog) - only ever meaningful as a same-day CUMULATIVE judgment,
// so every entry on an alcohol-logging streak but the latest one is kept at
// null/undefined, and the latest carries the running total's tag.
export type Assessment = "건강식" | "고지방" | "고탄수" | "과식" | "폭식" | "X" | "반주" | "과음" | "폭음";

export interface HealthLogEntry {
  date: string; // YYYY-MM-DD
  timestamp: number;
  raw_text: string;
  alcohol_g?: number;
  calories_est?: number;
  meal_type?: MealType;
  assessment?: Assessment;
  // sleep_hours is never set directly by the logging tool - it's always
  // computed from sleep_start/sleep_end (see appendHealthLog) so the model
  // never has to do the arithmetic itself, and so every sleep entry has a
  // real start/end to show instead of just a bare duration. Only entries
  // logged before this existed have sleep_hours without start/end.
  sleep_hours?: number | null;
  sleep_start?: string; // HH:MM, 24h
  sleep_end?: string; // HH:MM, 24h
  // When the thing being logged actually happened at a different moment than
  // when it was typed in (most commonly a backfilled/retroactive entry - see
  // update_health_entry's own doc comment), this carries the REAL time of the
  // event. Display and chronological sorting should always prefer this over
  // `timestamp` (which only ever means "when this row was written to disk").
  // Left unset for ordinary real-time logging, where timestamp already is
  // the event time.
  event_time?: string; // HH:MM, 24h
  exercise?: boolean;
  // Only meaningful when exercise is true - lets future advice logic weigh
  // aerobic vs. anaerobic balance instead of just a yes/no exercise flag.
  exercise_type?: ExerciseType;
}

export interface HealthTargets {
  sleep_hours_min?: number;
  weekly_alcohol_limit_g?: number;
}

// A periodic, AI-judged pass over recent logs - deliberately not a hardcoded
// point-scoring formula, unlike getShiftAdvice below. Whether "정크푸드만
// 계속 먹었다" or "운동을 너무 안 했다" counts as a real problem is a fuzzy,
// contextual judgment call (how many days, how severe, relative to the
// person's own baseline) that a fixed formula can't capture well - the same
// reasoning that made the "꿈" memory classification AI-judged rather than
// rule-based, just applied here instead of to shift-schedule math (which
// stays hardcoded because it's correctness-critical in a way a lifestyle
// judgment isn't).
export interface HealthReview {
  date: string; // YYYY-MM-DD this review was generated on
  concerns: string[]; // empty if nothing concerning found
  instruction: string; // one concrete action, in the same "지금 할 행동 하나" style as getShiftAdvice
  createdAt: number;
}

export interface HealthProfile {
  rotation_rules: RotationRule[];
  shift_overrides: Record<string, ShiftOverride>;
  confirmed_shifts: Record<string, string>;
  health_logs: HealthLogEntry[];
  targets: HealthTargets;
  latestReview?: HealthReview;
}

const DEFAULT_PROFILE: HealthProfile = {
  rotation_rules: [],
  shift_overrides: {},
  confirmed_shifts: {},
  health_logs: [],
  targets: {},
};

function loadProfile(): HealthProfile {
  try {
    const raw = fs.readFileSync(PROFILE_PATH, "utf-8");
    return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function saveProfile(profile: HealthProfile): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf-8");
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr(): string {
  return formatDate(new Date());
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}

function isPastOrToday(dateStr: string): boolean {
  return dateStr <= todayStr();
}

function findApplicableRule(profile: HealthProfile, dateStr: string): RotationRule | null {
  for (let i = profile.rotation_rules.length - 1; i >= 0; i--) {
    const r = profile.rotation_rules[i];
    if (dateStr < r.effective_from) continue;
    if (r.effective_until !== null && dateStr > r.effective_until) continue;
    return r;
  }
  return null;
}

function computeFromRule(rule: RotationRule, dateStr: string): string {
  const offset = daysBetween(rule.anchor_date, dateStr);
  const len = rule.pattern.length;
  const idx = ((offset % len) + len) % len;
  return rule.pattern[idx];
}

// Core rule: a past-or-today date is computed once and frozen into
// confirmed_shifts forever after. A rotation_rules change made later - even
// one that claims an effective_from in the past - can never silently alter a
// date that's already been resolved and potentially already shown to the
// user/AI. Only correctPastShift can touch an already-frozen date, and that's
// always an explicit, deliberate action.
export function resolveShiftCode(dateStr: string): string | null {
  const profile = loadProfile();

  if (isPastOrToday(dateStr)) {
    if (profile.confirmed_shifts[dateStr]) {
      return profile.confirmed_shifts[dateStr];
    }
    const override = profile.shift_overrides[dateStr];
    const rule = findApplicableRule(profile, dateStr);
    const code = override ? override.code : rule ? computeFromRule(rule, dateStr) : null;
    if (code) {
      profile.confirmed_shifts[dateStr] = code;
      saveProfile(profile);
    }
    return code;
  }

  // Future dates are always dynamic - never frozen, since they haven't
  // happened yet and legitimately should reflect the latest known plan.
  const override = profile.shift_overrides[dateStr];
  if (override) return override.code;
  const rule = findApplicableRule(profile, dateStr);
  return rule ? computeFromRule(rule, dateStr) : null;
}

export function correctPastShift(dateStr: string, code: string): void {
  if (!isPastOrToday(dateStr)) {
    throw new Error("correctPastShift는 오늘 또는 과거 날짜에만 사용합니다.");
  }
  const profile = loadProfile();
  profile.confirmed_shifts[dateStr] = code;
  saveProfile(profile);
}

export function addRotationRule(pattern: string, anchorDate: string, effectiveFrom: string): void {
  const profile = loadProfile();
  for (const r of profile.rotation_rules) {
    if (r.effective_until === null) {
      r.effective_until = addDays(effectiveFrom, -1);
    }
  }
  profile.rotation_rules.push({ pattern, anchor_date: anchorDate, effective_from: effectiveFrom, effective_until: null });
  saveProfile(profile);
}

export function setShiftOverride(dateStr: string, code: string, reason?: string): void {
  const profile = loadProfile();
  profile.shift_overrides[dateStr] = reason ? { code, reason } : { code };
  saveProfile(profile);
  // If this override lands on a date that's already past/today, resolve it
  // right away so it gets frozen into confirmed_shifts immediately rather
  // than waiting for the next unrelated read.
  if (isPastOrToday(dateStr)) resolveShiftCode(dateStr);
}

// Thin loop over setShiftOverride so a multi-day event (vacation, extended
// leave) is one tool call instead of one per day - built on the exact same
// per-day path, so it can't drift from the single-date behavior (freezing,
// saving) in some subtly different way.
export function setShiftOverrideRange(startDate: string, endDate: string, code: string, reason?: string): void {
  let d = startDate;
  while (d <= endDate) {
    setShiftOverride(d, code, reason);
    d = addDays(d, 1);
  }
}

// Overnight sleep (e.g. 23:30 -> 07:00) wraps past midnight - treated as a
// positive duration by adding a day whenever the raw end-minus-start comes
// out negative, rather than ever reporting a negative sleep length.
function computeSleepHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 10) / 10;
}

// Cumulative same-day alcohol total -> assessment tag. Deterministic and
// hardcoded on purpose (same reasoning as getShiftAdvice below) rather than
// left to the model: the model only ever reports what's in THIS message, so
// it has no reliable way to know the day's running total on its own.
const ALCOHOL_ASSESSMENT_THRESHOLDS: [number, Assessment][] = [
  [60, "폭음"],
  [20, "과음"],
  [0, "반주"],
];

function alcoholAssessmentForTotal(totalG: number): Assessment {
  for (const [min, tag] of ALCOHOL_ASSESSMENT_THRESHOLDS) {
    if (totalG >= min) return tag;
  }
  return "반주";
}

// Recomputes one date's alcohol cascade from scratch: every same-day entry
// with alcohol_g has its tag cleared, then only the chronologically LAST one
// gets the tag, based on that date's current total. Shared by append/update/
// delete so a session that escalates (반주 -> 과음 -> 폭음) - or gets
// corrected or has an entry removed partway through - always re-settles on
// the one entry that should actually carry the day's tag, rather than each
// mutation path reimplementing this independently and drifting apart.
function recomputeAlcoholCascadeForDate(profile: HealthProfile, date: string): void {
  const dayAlcoholLogs = profile.health_logs
    .filter((l) => l.date === date && l.alcohol_g)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (dayAlcoholLogs.length === 0) return;

  let total = 0;
  for (const log of dayAlcoholLogs) {
    total += log.alcohol_g!;
    delete log.assessment;
  }
  dayAlcoholLogs[dayAlcoholLogs.length - 1].assessment = alcoholAssessmentForTotal(total);
}

export function appendHealthLog(entry: Omit<HealthLogEntry, "timestamp">): void {
  const profile = loadProfile();
  const resolved: HealthLogEntry = { ...entry, timestamp: Date.now() };
  if (resolved.sleep_start && resolved.sleep_end) {
    resolved.sleep_hours = computeSleepHours(resolved.sleep_start, resolved.sleep_end);
  }

  profile.health_logs.push(resolved);
  profile.health_logs = profile.health_logs.slice(-MAX_LOGS);
  if (resolved.alcohol_g && resolved.alcohol_g > 0) {
    recomputeAlcoholCascadeForDate(profile, resolved.date);
  }
  saveProfile(profile);
}

// Both take `timestamp` to identify the exact entry - the model should get
// this from query_health_history (or from a log_health_entry call it just
// made this same turn) rather than ever guessing, since silently touching
// the wrong entry is much worse than asking the user to clarify first.
export function updateHealthLog(timestamp: number, patch: Partial<Omit<HealthLogEntry, "timestamp">>): boolean {
  const profile = loadProfile();
  const log = profile.health_logs.find((l) => l.timestamp === timestamp);
  if (!log) return false;

  const oldDate = log.date;
  Object.assign(log, patch);
  if (patch.sleep_start && patch.sleep_end) {
    log.sleep_hours = computeSleepHours(patch.sleep_start, patch.sleep_end);
  }

  recomputeAlcoholCascadeForDate(profile, oldDate);
  if (log.date !== oldDate) recomputeAlcoholCascadeForDate(profile, log.date);
  saveProfile(profile);
  return true;
}

export function deleteHealthLog(timestamp: number): boolean {
  const profile = loadProfile();
  const log = profile.health_logs.find((l) => l.timestamp === timestamp);
  if (!log) return false;

  const date = log.date;
  profile.health_logs = profile.health_logs.filter((l) => l.timestamp !== timestamp);
  recomputeAlcoholCascadeForDate(profile, date);
  saveProfile(profile);
  return true;
}

export function updateTargets(patch: HealthTargets): void {
  const profile = loadProfile();
  profile.targets = { ...profile.targets, ...patch };
  saveProfile(profile);
}

// --- Shift-code -> advice lookup (deterministic, per the plan doc's table -
// this is fixed logic, not something the model is asked to reason out). ---
export function getShiftAdvice(dateStr: string): string {
  const today = resolveShiftCode(dateStr);
  const yesterday = resolveShiftCode(addDays(dateStr, -1));
  const tomorrow = resolveShiftCode(addDays(dateStr, 1));

  if (!today) return "등록된 근무 규칙이 없습니다.";

  if (today.length > 1) {
    return "연속·겹침 근무입니다. 운동·개인 일정은 전부 스킵하고, 근무 종료 즉시 수면을 최우선으로 하세요.";
  }
  if (today === "N" && tomorrow === "N") {
    return "연속 야간 근무입니다. 근무일 사이 수면 시간대를 최대한 고정하세요 (기상/취침 시각을 바꾸지 않기).";
  }
  if (tomorrow === "N") {
    return "다음 근무가 야간입니다. 근무 시작 전 긴 낮잠(1.5~2시간)을 권장하며, 카페인은 근무 시작 6시간 전까지만 섭취하세요.";
  }
  if (today === "N") {
    return "야간 근무 중/직후입니다. 퇴근길엔 햇빛을 차단(선글라스 등)하고 귀가 즉시 암막 환경에서 수면하세요. 운동·외부 일정은 피하세요.";
  }
  if (today === "D") {
    return "주간 근무입니다. 평소 수면 스케줄을 유지하고, 오후 늦은 시간 카페인은 자제하세요.";
  }
  if (today === "A") {
    return "오후 근무입니다. 퇴근 후 늦은 시간 과식을 주의하고, 취침 전 알코올은 수면의 질을 떨어뜨리니 자제를 권장합니다.";
  }
  if (today === "X") {
    if (yesterday === "N") {
      return "야간 근무 직후 휴무입니다. 낮 시간 가벼운 산책 정도는 괜찮지만, 본 수면(핵심 회복)이 여전히 최우선입니다.";
    }
    if (yesterday === "X") {
      return "연속 휴무 중입니다. 점진적으로 정상 수면 리듬으로 복귀해도 되지만, 다음 근무가 야간이라면 복귀 전날엔 다시 그에 맞춰 조정하세요.";
    }
    return "휴무일입니다. 전후 근무와 리듬이 크게 어긋나지 않도록 평소 수면 패턴에서 크게 벗어나지 마세요.";
  }
  return "특별한 권장 사항이 없습니다.";
}

function formatLogSummary(l: HealthLogEntry): string {
  const parts = [l.raw_text];
  if (l.calories_est) parts.push(`약 ${l.calories_est}kcal`);
  if (l.alcohol_g) parts.push(`알코올 ${l.alcohol_g}g`);
  if (l.sleep_start && l.sleep_end) parts.push(`수면 ${l.sleep_start}~${l.sleep_end} (총 ${l.sleep_hours}시간)`);
  else if (l.sleep_hours) parts.push(`수면 ${l.sleep_hours}시간`); // pre-existing entries without start/end
  if (l.exercise) parts.push(`운동(${l.exercise_type ?? "종류 미상"})`);
  return parts.join(" / ");
}

export interface HealthLogQueryEntry {
  date: string;
  timestamp: number; // the exact id needed by update_health_entry/delete_health_entry
  shiftCode: string | null;
  summary: string;
}

// The ambient [근무/건강 정보] block only ever shows the last 3 log entries
// (see getHealthSummary), so anything further back or any date-range
// question ("이번 주 평균 음주량", "지난달 수면 패턴") has no read path at
// all today - only write tools exist. This is the read counterpart,
// deliberately a real tool call (not folded into the always-on ambient
// block like the summary is) since a full-range query is only occasionally
// needed and would otherwise cost context on every single message.
const MAX_QUERY_RANGE_DAYS = 90;

export function queryHealthLogs(startDate: string, endDate: string): HealthLogQueryEntry[] {
  const cappedEnd = daysBetween(startDate, endDate) > MAX_QUERY_RANGE_DAYS ? addDays(startDate, MAX_QUERY_RANGE_DAYS) : endDate;
  const profile = loadProfile();
  return profile.health_logs
    .filter((l) => l.date >= startDate && l.date <= cappedEnd)
    .map((l) => ({ date: l.date, timestamp: l.timestamp, shiftCode: resolveShiftCode(l.date), summary: formatLogSummary(l) }));
}

// Hour ranges for each shift code - matches what's now written into the
// owner profile and the ambient [근무/건강 정보] block (see memory.ts's
// buildHealthInfo). Kept here too since the 건강관리 tab needs to render a
// human-readable range next to each work-schedule row, not just the bare code.
const EXERCISE_TYPE_KO: Record<ExerciseType, string> = {
  aerobic: "유산소",
  anaerobic: "무산소",
  mixed: "복합",
};

const SHIFT_HOUR_RANGES: Record<string, string> = {
  N: "00:00~08:00",
  D: "08:00~16:00",
  A: "16:00~24:00",
  X: "휴무",
};

export type HealthRecordCategory = "diet" | "exercise" | "sleep";

export interface WorkRecordItem {
  date: string;
  code: string;
  hourRange: string;
}

export interface HealthLogRecordItem {
  date: string;
  time: string; // HH:MM - the entry's event_time if known, else derived from timestamp
  timestamp: number;
  // Epoch ms built from `date`+`time` (not from the entry's raw `timestamp`),
  // so a backfilled entry sorts into its real chronological slot instead of
  // wherever its creation time happens to fall. The mobile client's
  // "시간순" sort must use this, never `timestamp`.
  sortKey: number;
  text: string;
  detail: string | null;
  // Raw numeric values behind `detail`'s formatted text - the mobile client
  // needs these (not string-parsing) to compute each date's daily totals.
  calories?: number;
  alcoholG?: number;
  sleepHours?: number;
  // Diet-only: lets the mobile UI render a condensed single line (time ·
  // 종류 · 평가 · kcal) with `text` (the full raw description) tucked behind
  // a tap-to-expand toggle instead of always shown inline.
  mealType?: string;
  assessment?: string;
  // 운동-only: 유산소/무산소/복합 (exercise_type의 한글 번역, 미리 변환해서 보냄
  // - 모바일 클라이언트가 enum 번역 테이블을 따로 갖고 있을 필요 없게).
  exerciseType?: string;
}

export interface HealthRecordsResult {
  work: WorkRecordItem[];
  diet: HealthLogRecordItem[];
  exercise: HealthLogRecordItem[];
  sleep: HealthLogRecordItem[];
}

function formatTimeOfDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Backs the 모바일 앱's 건강관리 탭- distinct from queryHealthLogs (the AI
// tool's read path, capped at 90 days and returning one flattened summary
// string per log) because the UI needs per-category filtering and each
// entry's actual time-of-day, not just its date.
export const MAX_RECORDS_RANGE_DAYS = 30;

export function getHealthRecordsForRange(
  startDate: string,
  endDate: string,
  categories: Set<HealthRecordCategory | "work">
): HealthRecordsResult {
  const cappedEnd = daysBetween(startDate, endDate) > MAX_RECORDS_RANGE_DAYS ? addDays(startDate, MAX_RECORDS_RANGE_DAYS) : endDate;
  const profile = loadProfile();
  const logsInRange = profile.health_logs.filter((l) => l.date >= startDate && l.date <= cappedEnd);

  const result: HealthRecordsResult = { work: [], diet: [], exercise: [], sleep: [] };

  if (categories.has("work")) {
    for (let d = startDate; d <= cappedEnd; d = addDays(d, 1)) {
      const code = resolveShiftCode(d);
      if (code) result.work.push({ date: d, code, hourRange: SHIFT_HOUR_RANGES[code] ?? "미상" });
    }
  }

  // A single raw log entry can carry diet AND sleep data at once (e.g.
  // "저녁 먹고 낮잠 잤어") - rather than arbitrarily splitting one
  // natural-language entry apart, the same entry (with its full text) is
  // included once per category it actually has data for, so each filtered
  // view stays self-contained and readable.
  //
  // calories_est is NOT diet-exclusive, though - it's also how much a walk
  // or a set of pushups burned (e.g. "도보 출근 3.5km" carries both
  // exercise: true and calories_est: 170), so a plain "has calories_est"
  // check wrongly pulled every exercise entry into the diet list too. Diet
  // means "consumed something", which this app only ever logs on entries
  // that aren't marked as exercise.
  for (const l of logsInRange) {
    // Prefer the entry's own knowledge of when it actually happened over its
    // creation timestamp: an explicit event_time first, then (sleep-only) its
    // start time, finally falling back to the creation time for ordinary
    // real-time-logged entries where that's already correct.
    const time = l.event_time ?? l.sleep_start ?? formatTimeOfDay(l.timestamp);
    const sortKey = new Date(`${l.date}T${time}:00`).getTime();
    const base = { date: l.date, time, timestamp: l.timestamp, sortKey, text: l.raw_text };
    if (categories.has("diet") && !l.exercise && (l.calories_est || l.alcohol_g)) {
      const parts: string[] = [];
      if (l.calories_est) parts.push(`약 ${l.calories_est}kcal`);
      if (l.alcohol_g) parts.push(`알코올 ${l.alcohol_g}g`);
      result.diet.push({
        ...base,
        detail: parts.join(", ") || null,
        calories: l.calories_est,
        alcoholG: l.alcohol_g,
        mealType: l.meal_type,
        assessment: l.assessment,
      });
    }
    if (categories.has("exercise") && l.exercise) {
      const kcalPart = l.calories_est ? ` · 약 ${l.calories_est}kcal` : "";
      result.exercise.push({
        ...base,
        detail: `운동(${l.exercise_type ? EXERCISE_TYPE_KO[l.exercise_type] : "종류 미상"})${kcalPart}`,
        calories: l.calories_est,
        exerciseType: l.exercise_type ? EXERCISE_TYPE_KO[l.exercise_type] : undefined,
      });
    }
    if (categories.has("sleep") && l.sleep_hours) {
      // When start/end exist (every entry logged after this feature shipped),
      // the range itself replaces `text` so the mobile UI can render sleep
      // as a single line ("HH:MM~HH:MM · 총 X시간") instead of a reported-at
      // time plus a separate free-text line - the reported time was never
      // meaningful for sleep anyway, since it's always reported well after
      // waking. Entries from before this existed only have sleep_hours, so
      // they keep falling back to their original raw_text.
      const text = l.sleep_start && l.sleep_end ? `${l.sleep_start}~${l.sleep_end}` : base.text;
      result.sleep.push({ ...base, text, detail: `총 ${l.sleep_hours}시간`, sleepHours: l.sleep_hours });
    }
  }

  return result;
}

export interface HealthSummary {
  recent_and_upcoming_shifts: Record<string, string>;
  recent_logs: HealthLogEntry[];
  targets: HealthTargets;
  today_advice: string;
}

export function getHealthSummary(pastDays = 3, futureDays = 4): HealthSummary {
  const profile = loadProfile();
  const today = todayStr();

  const shifts: Record<string, string> = {};
  for (let i = -pastDays; i <= futureDays; i++) {
    const d = addDays(today, i);
    const code = resolveShiftCode(d);
    if (code) shifts[d] = code;
  }

  return {
    recent_and_upcoming_shifts: shifts,
    recent_logs: profile.health_logs.slice(-10),
    targets: profile.targets,
    today_advice: getShiftAdvice(today),
  };
}

export function getLatestReview(): HealthReview | null {
  return loadProfile().latestReview ?? null;
}

function setLatestReview(review: HealthReview): void {
  const profile = loadProfile();
  profile.latestReview = review;
  saveProfile(profile);
}

// A review is naturally welcome right when the user resumes activity after a
// real break (waking up, before the first meal) - not the instant a calendar
// day ticks over regardless of what's being discussed. There's no fixed
// clock time to anchor that on for a shift worker, so - same reasoning as the
// "꿈" idle trigger - a long gap since the last message is used as a proxy
// for "a break just ended" instead. 3 hours is short enough to still catch a
// nap-length break, long enough not to fire after an ordinary pause between
// messages.
const REVIEW_MIN_IDLE_GAP_MS = 3 * 60 * 60 * 1000;

// One review per calendar day at most - lifestyle patterns don't need
// checking more often than that, and a daily cadence means this never needs
// a chat-disabling lock the way the heavier "꿈" memory cycle does: it's a
// single lightweight API call, not a big classification job, so it can just
// run in the background without disrupting anything.
export function isReviewOpportunity(idleGapMs: number): boolean {
  const last = getLatestReview();
  const alreadyReviewedToday = last && last.date === todayStr();
  if (alreadyReviewedToday) return false;
  return idleGapMs >= REVIEW_MIN_IDLE_GAP_MS;
}

// Once a review exists for today, whether to actually *mention* it is a
// separate judgment from whether it exists at all - showing it on every
// single message for the rest of the day means it eventually interrupts an
// unrelated conversation thread already in progress. Reusing the same
// "gap since the last message" signal (rather than an unrelated expiry
// timer) keeps this consistent with how the review gets generated in the
// first place: it surfaces once at the start of each resumed conversation,
// not on a schedule of its own. The bar for re-surfacing an existing review
// is lower than for generating a brand new one, so this gap is shorter than
// REVIEW_MIN_IDLE_GAP_MS.
const REVIEW_DISPLAY_MIN_GAP_MS = 30 * 60 * 1000;

export function shouldDisplayReview(idleGapMs: number): boolean {
  const review = getLatestReview();
  if (!review || review.date !== todayStr()) return false;
  return idleGapMs >= REVIEW_DISPLAY_MIN_GAP_MS;
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    concerns: { type: "array", items: { type: "string" } },
    instruction: { type: "string" },
  },
  required: ["concerns", "instruction"],
  additionalProperties: false,
};

interface ReviewClassification {
  concerns?: string[];
  instruction?: string;
}

// A flat 7-day calendar window doesn't mean much for a shift worker whose
// overeating/overdrinking tracks their rotation (rest days, or the day
// before one) rather than the day of the week. ~30 days covers several full
// rotations of a typical ~12-day pattern (NNNXXDDXAAAX) without hardcoding
// the exact cycle length here, since that length isn't fixed - it's whatever
// the currently active RotationRule says, and can itself change every few
// months.
const REVIEW_WINDOW_DAYS = 30;

// Always goes through Gemini regardless of which provider is live for chat
// right now - same reasoning as the dream classification and embeddings:
// this is a backend judgment task, independent of the user-facing provider
// toggle.
export async function generateHealthReview(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const profile = loadProfile();
  const today = todayStr();
  const windowStart = addDays(today, -REVIEW_WINDOW_DAYS);
  const recentLogs = profile.health_logs.filter((l) => l.date >= windowStart);
  if (recentLogs.length === 0) return;

  const logsByDate = new Map<string, HealthLogEntry[]>();
  for (const log of recentLogs) {
    const list = logsByDate.get(log.date) ?? [];
    list.push(log);
    logsByDate.set(log.date, list);
  }

  // One line per calendar day (not per log) with the shift code inline, so
  // the model can directly see "근무일 vs 휴무일(또는 휴무 전날)" against
  // what was eaten/drunk that day, instead of having to cross-reference two
  // separate lists itself.
  const dayLines: string[] = [];
  for (let d = windowStart; d <= today; d = addDays(d, 1)) {
    const shiftCode = resolveShiftCode(d) ?? "?";
    const logs = logsByDate.get(d);
    if (!logs || logs.length === 0) {
      dayLines.push(`${d} [근무:${shiftCode}]: (기록 없음)`);
      continue;
    }
    const summary = logs.map(formatLogSummary).join(" | ");
    dayLines.push(`${d} [근무:${shiftCode}]: ${summary}`);
  }

  const targetParts: string[] = [];
  if (profile.targets.sleep_hours_min) targetParts.push(`최소 수면 ${profile.targets.sleep_hours_min}시간`);
  if (profile.targets.weekly_alcohol_limit_g) targetParts.push(`주간 알코올 한도 ${profile.targets.weekly_alcohol_limit_g}g`);

  const prompt = `아래는 지난 ${REVIEW_WINDOW_DAYS}일간 사용자의 근무 코드와 식사/음주/수면/운동 기록을 날짜별로 합친 것입니다 (근무 코드: N=야간, D=주간, A=오후, X=휴무, ?=근무 규칙 미확인).

사용자는 교대근무자로, 근무일에는 대체로 과식·과음을 하지 않지만 **당일이 휴무이거나 다음날이 휴무일 때 과식·과음하는 경향**이 있습니다. 단순히 날짜순으로 반복되는 패턴이 아니라, 이 근무-휴무 상관관계를 반드시 감안해서 판단하세요. 근무 로테이션은 대략 12일 주기(NNNXXDDXAAAX)이거나 그 하위 구간(NNNXX / DDXAAAX) 단위로 반복되니, 이번 주기와 이전 몇 주기를 비교해서 판단해도 좋습니다.

- 하루짜리 단발성 일탈이 아니라, 여러 번의 휴무(또는 휴무 전날)에 걸쳐 반복되는 패턴만 문제로 취급하세요.
- concerns: 실제로 우려되는 패턴이 있을 때만 짧은 문구로 나열 (없으면 빈 배열).
- instruction: 지금 당장 할 수 있는 구체적 행동 하나만 간결하게 제시. 문제가 없다면 지금 패턴을 유지하라는 긍정적 지침을 주세요. 복잡한 계획을 세우지 마세요.

${targetParts.length > 0 ? `사용자가 설정한 목표: ${targetParts.join(", ")}\n\n` : ""}지난 ${REVIEW_WINDOW_DAYS}일 근무·기록:
${dayLines.join("\n")}`;

  try {
    const client = new GoogleGenAI({ apiKey });
    const config = loadConfig();
    const interaction = await client.interactions.create({
      model: config.geminiModel,
      input: prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: REVIEW_SCHEMA,
      },
    });
    const parsed = JSON.parse(interaction.output_text ?? "{}") as ReviewClassification;
    if (!parsed.instruction) return;

    setLatestReview({
      date: today,
      concerns: parsed.concerns ?? [],
      instruction: parsed.instruction,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("Health review generation failed:", err);
  }
}
