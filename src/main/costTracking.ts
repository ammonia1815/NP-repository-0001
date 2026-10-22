import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

// Google exposes no direct "X/5000 free search queries used this month" or
// "running cost so far" figure anywhere in Cloud Billing, AI Studio's usage
// dashboard, or the Quotas/Rate Limits pages - confirmed by actually
// checking all four during a real investigation session. The closest
// available signal is cross-referencing a billing $ chart against a request-
// count chart by eye, after the fact. Since gemini.ts already extracts the
// exact token usage and exact search-query count from every API response
// (see logTokenUsage/logSearchUsage), this module keeps its own running
// tally locally instead - built from the same real numbers the API already
// hands back, not a guess.
export interface DailyGeminiCost {
  date: string; // local "YYYY-MM-DD"
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  searchQueries: number;
  estimatedCostKrw: number;
}

interface CostTrackingState {
  // UTC "YYYY-MM" - matches Google's own free-tier reset boundary (confirmed
  // via official docs: resets at the start of the UTC billing cycle), not
  // local time, so the free/paid split computed here lines up with Google's.
  searchMonthKey: string;
  searchMonthTotal: number;
  daily: Record<string, DailyGeminiCost>;
}

// Official per-unit prices (ai.google.dev/gemini-api/docs/pricing, confirmed
// Oct 2026) for gemini-3.8-flash and its search grounding tool.
const FREE_SEARCH_QUERIES_PER_MONTH = 5000;
const PRICE_PER_PAID_SEARCH_QUERY_USD = 0.014; // $14 / 1,000 queries past the free allowance
// gemini.ts's own logTokenUsage carries a confirmed-empirical note: on this
// Interactions API path, Gemini's implicit caching never actually activates,
// so a non-zero "cached" token count in the usage response does NOT get the
// discounted cache rate at billing time - every input token is paid at the
// full rate regardless. Pricing all input tokens (cached field included) at
// PRICE_PER_INPUT_TOKEN_USD reflects that, rather than the discounted
// $0.075/1M rate that would apply if caching were genuinely in effect here.
const PRICE_PER_INPUT_TOKEN_USD = 0.75 / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN_USD = 3.75 / 1_000_000;
// A fixed approximation (checked Oct 2026), not a live rate - this whole
// module is a rough day-to-day estimate to avoid digging through Cloud
// Billing, not a replacement for the real invoice, so exactness here isn't
// the point.
const USD_TO_KRW = 1335;

function getCostTrackingPath(): string {
  return path.join(app.getPath("userData"), "cost-tracking.json");
}

function loadState(): CostTrackingState {
  try {
    const raw = fs.readFileSync(getCostTrackingPath(), "utf-8");
    return JSON.parse(raw) as CostTrackingState;
  } catch {
    return { searchMonthKey: "", searchMonthTotal: 0, daily: {} };
  }
}

function saveState(state: CostTrackingState): void {
  fs.writeFileSync(getCostTrackingPath(), JSON.stringify(state, null, 2), "utf-8");
}

function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function utcMonthKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export interface GeminiUsageForTracking {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  searchQueries: number;
}

// Called right after every Gemini call (initial + each follow-up round) that
// has usage info - see gemini.ts's two call sites, right next to its
// existing logTokenUsage/logSearchUsage calls. A batch of search queries is
// split into free vs. paid based on how much of the current UTC month's
// 5,000 free allowance was already used BEFORE this call - e.g. a day where
// the monthly total crosses from 4,950 to 5,050 correctly prices only the
// last 50 queries of that batch, not all of them.
export function recordGeminiUsage(usage: GeminiUsageForTracking): void {
  const now = new Date();
  const state = loadState();

  const thisMonth = utcMonthKey(now);
  if (state.searchMonthKey !== thisMonth) {
    state.searchMonthKey = thisMonth;
    state.searchMonthTotal = 0;
  }

  const freeRemaining = Math.max(0, FREE_SEARCH_QUERIES_PER_MONTH - state.searchMonthTotal);
  const paidQueries = Math.max(0, usage.searchQueries - freeRemaining);
  state.searchMonthTotal += usage.searchQueries;

  // usage.inputTokens is the FULL input count (cachedTokens is a subset of
  // it, reported separately only for visibility - see the no-real-caching
  // note above PRICE_PER_INPUT_TOKEN_USD), so it alone is priced here; adding
  // a separate cachedTokens charge on top would double-count those tokens.
  const tokenCostUsd = usage.inputTokens * PRICE_PER_INPUT_TOKEN_USD + usage.outputTokens * PRICE_PER_OUTPUT_TOKEN_USD;
  const searchCostUsd = paidQueries * PRICE_PER_PAID_SEARCH_QUERY_USD;
  const costKrw = (tokenCostUsd + searchCostUsd) * USD_TO_KRW;

  const dateKey = localDateKey(now);
  const existing: DailyGeminiCost = state.daily[dateKey] ?? {
    date: dateKey,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    searchQueries: 0,
    estimatedCostKrw: 0,
  };
  existing.inputTokens += usage.inputTokens;
  existing.cachedTokens += usage.cachedTokens;
  existing.outputTokens += usage.outputTokens;
  existing.searchQueries += usage.searchQueries;
  existing.estimatedCostKrw += costKrw;
  state.daily[dateKey] = existing;

  saveState(state);
}

export interface SearchQuotaStatus {
  monthKey: string;
  used: number;
  limit: number;
}

// Used by the tray menu's on-demand "검색 사용량 확인" check and the 80%/100%
// threshold alerts - reads fresh each time rather than caching, since this
// is cheap (one small JSON file) and must never show a stale number.
export function getSearchQuotaStatus(): SearchQuotaStatus {
  const state = loadState();
  const thisMonth = utcMonthKey(new Date());
  if (state.searchMonthKey !== thisMonth) {
    return { monthKey: thisMonth, used: 0, limit: FREE_SEARCH_QUERIES_PER_MONTH };
  }
  return { monthKey: state.searchMonthKey, used: state.searchMonthTotal, limit: FREE_SEARCH_QUERIES_PER_MONTH };
}

export function getDailyCostHistory(): DailyGeminiCost[] {
  const state = loadState();
  return Object.values(state.daily).sort((a, b) => a.date.localeCompare(b.date));
}
