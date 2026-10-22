interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  emotion?: string;
  timestamp: number;
  source?: string;
  model?: string;
  hasPhotoAttachment?: boolean;
  hasScreenView?: boolean;
}

// Same icon convention as the avatar overlay's provider-switch buttons
// (avatar/index.html) - ⚡ Gemini, 🧠 Claude, 🦙 local.
const HISTORY_MODEL_ICONS: Record<string, string> = { gemini: "⚡", "gemini-fast": "💨", claude: "🧠", local: "🦙" };

interface Window {
  historyAPI: {
    getHistory: () => Promise<StoredTurn[]>;
    onOpen: (callback: () => void) => void;
    close: () => void;
  };
}

const body = document.getElementById("history-body") as HTMLDivElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const startDateInput = document.getElementById("start-date") as HTMLInputElement;
const endDateInput = document.getElementById("end-date") as HTMLInputElement;
const rangeApplyBtn = document.getElementById("range-apply-btn") as HTMLButtonElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const searchCount = document.getElementById("search-count") as HTMLSpanElement;

// All turns fetched once per window-open; date range filtering happens
// entirely client-side against this array instead of re-querying the main
// process, since the full history easily fits in memory and this keeps
// "조회" instant with no IPC round-trip.
let allTurns: StoredTurn[] = [];

// Search state - rebuilt from the currently rendered (date-filtered) bubbles
// whenever the search term or the visible range changes, so "다음 찾기"
// always cycles through what's actually on screen rather than the full
// unfiltered history.
let searchMatches: HTMLElement[] = [];
let searchIndex = -1;
let lastSearchTerm = "";

function dateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dividerId(key: string): string {
  return `date-${key}`;
}

// "YYYY-MM-DD" from an <input type="date"> parses as UTC midnight, not local
// midnight - going through a local Date constructor instead keeps the range
// boundaries aligned with how dateKey() above buckets each turn's own local
// day, so a turn right at the edge of a day doesn't fall on the wrong side.
function startOfLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function endOfLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function toDateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function render(turns: StoredTurn[]): void {
  body.textContent = "";
  body.classList.toggle("empty", turns.length === 0);
  resetSearch();

  if (turns.length === 0) {
    body.textContent = "이 기간에는 저장된 대화 기록이 없습니다.";
    return;
  }

  let lastDate = "";
  for (const turn of turns) {
    const key = dateKey(turn.timestamp);
    if (key !== lastDate) {
      lastDate = key;
      const divider = document.createElement("div");
      divider.id = dividerId(key);
      divider.className = "date-divider";
      divider.textContent = key;
      body.appendChild(divider);
    }

    const bubble = document.createElement("div");
    bubble.className = `bubble ${turn.role} source-${turn.source ?? "desktop"}`;
    bubble.appendChild(document.createTextNode(turn.text));

    if (turn.hasPhotoAttachment || turn.hasScreenView) {
      const badge = document.createElement("span");
      badge.className = "attach-badge";
      badge.textContent = turn.hasPhotoAttachment ? " 📷" : " 👁";
      bubble.appendChild(badge);
    }

    const modelIcon = turn.model ? HISTORY_MODEL_ICONS[turn.model] : undefined;
    if (modelIcon) {
      const badge = document.createElement("span");
      badge.className = "model-badge";
      badge.textContent = ` ${modelIcon}`;
      bubble.appendChild(badge);
    }

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = timeLabel(turn.timestamp);
    bubble.appendChild(time);

    body.appendChild(bubble);
  }

  body.scrollTop = body.scrollHeight;
}

function applyRange(): void {
  const startVal = startDateInput.value;
  const endVal = endDateInput.value;
  if (!startVal || !endVal) return;

  const start = startOfLocalDay(startVal);
  const end = endOfLocalDay(endVal);
  const filtered = allTurns.filter((t) => t.timestamp >= start && t.timestamp <= end);
  render(filtered);
}

function resetSearch(): void {
  searchMatches = [];
  searchIndex = -1;
  lastSearchTerm = "";
  searchCount.textContent = "";
}

// Rebuilds the match list from whatever is currently rendered (not the full
// history) so search always operates on the visible date range - widening
// the range is how the user reaches older matches, per how this was asked
// for alongside the range feature rather than as two unrelated tools.
function runSearch(): void {
  const term = searchInput.value.trim();
  if (!term) {
    resetSearch();
    return;
  }

  const isNewSearch = term !== lastSearchTerm;
  if (isNewSearch) {
    lastSearchTerm = term;
    const lowerTerm = term.toLowerCase();
    searchMatches = Array.from(body.querySelectorAll<HTMLElement>(".bubble")).filter((el) =>
      (el.textContent ?? "").toLowerCase().includes(lowerTerm)
    );
    searchIndex = -1;
  }

  if (searchMatches.length === 0) {
    searchCount.textContent = "0/0";
    return;
  }

  searchMatches[searchIndex]?.classList.remove("search-current");
  searchIndex = (searchIndex + 1) % searchMatches.length;
  const current = searchMatches[searchIndex];
  current.classList.add("search-current");
  current.scrollIntoView({ block: "center" });
  searchCount.textContent = `${searchIndex + 1}/${searchMatches.length}`;
}

async function refresh(): Promise<void> {
  allTurns = await window.historyAPI.getHistory();

  // Defaults to the most recent 7 days on every fresh open, per how this
  // window is meant to be used - a quick recent-context check first, with
  // the explicit range picker there for anything older.
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  startDateInput.value = toDateInputValue(weekAgo);
  endDateInput.value = toDateInputValue(today);

  applyRange();
}

closeBtn.addEventListener("click", () => {
  window.historyAPI.close();
});

rangeApplyBtn.addEventListener("click", applyRange);

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
// Typing a different term should restart from the first match on the next
// search click rather than continuing a stale cycle through the old term's
// matches.
searchInput.addEventListener("input", () => {
  if (searchInput.value.trim() !== lastSearchTerm) {
    searchMatches[searchIndex]?.classList.remove("search-current");
    searchIndex = -1;
    lastSearchTerm = "";
    searchCount.textContent = "";
  }
});

window.historyAPI.onOpen(refresh);
refresh();
