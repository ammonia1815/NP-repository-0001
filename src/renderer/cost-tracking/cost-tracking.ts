// Renderer .ts files are plain <script> tags with no module loader present
// at runtime, so TypeScript must never emit CommonJS output for them - an
// earlier version of this file used `export {}` (to avoid the top-level
// name collisions noted below) and that alone was enough to make the
// compiler emit an `exports` reference even under tsconfig.renderer.json's
// "module": "None", which crashed with "ReferenceError: exports is not
// defined" as the very first line of the compiled script - confirmed for
// real via the renderer's own devtools console, forwarded to the main
// process log. Every line after that (the quota bar, the table, the close
// button's click handler) silently never ran, on every launch since this
// file was first written. Fixed by dropping `export {}`/`declare global`
// entirely and instead giving every top-level name here a `cost`-prefixed
// name unique across the other renderer pages (history.ts and chat.ts each
// load as their own global script too, and collide on generic names like
// `body`/`closeBtn`/`refresh` otherwise - confirmed for real against
// history.ts before this file existed).
interface DailyGeminiCost {
  date: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  searchQueries: number;
  estimatedCostKrw: number;
}

interface SearchQuotaStatus {
  monthKey: string;
  used: number;
  limit: number;
}

interface Window {
  costTrackingAPI: {
    getHistory: () => Promise<DailyGeminiCost[]>;
    getSearchQuota: () => Promise<SearchQuotaStatus>;
    onOpen: (callback: () => void) => void;
    close: () => void;
  };
}

const costBody = document.getElementById("cost-body") as HTMLDivElement;
const costCloseBtn = document.getElementById("close-btn") as HTMLButtonElement;
const costQuotaBar = document.getElementById("search-quota-bar") as HTMLDivElement;

function formatKrw(n: number): string {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

function formatNum(n: number): string {
  return n.toLocaleString("ko-KR");
}

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderQuota(quota: SearchQuotaStatus): void {
  const pct = quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
  const fillClass = quota.used >= quota.limit ? "over" : quota.used >= quota.limit * 0.8 ? "warn" : "";
  costQuotaBar.innerHTML = "";

  const label = document.createElement("div");
  label.textContent = `이번 달(UTC) 무료 검색 사용량: ${formatNum(quota.used)} / ${formatNum(quota.limit)}건`;
  costQuotaBar.appendChild(label);

  const track = document.createElement("div");
  track.className = "track";
  const fill = document.createElement("div");
  fill.className = `fill ${fillClass}`;
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  costQuotaBar.appendChild(track);
}

function renderTable(days: DailyGeminiCost[]): void {
  costBody.textContent = "";
  costBody.classList.toggle("empty", days.length === 0);

  if (days.length === 0) {
    costBody.textContent = "아직 기록된 사용량이 없습니다.";
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>날짜</th><th>입력 토큰</th><th>출력 토큰</th><th>검색</th><th>예상 비용</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const today = todayKey();
  let totalInput = 0;
  let totalOutput = 0;
  let totalSearch = 0;
  let totalCost = 0;

  // Newest day first - matches how someone checking "how much today/this
  // week" actually wants to read it, rather than scrolling to the bottom.
  for (const day of [...days].reverse()) {
    const tr = document.createElement("tr");
    if (day.date === today) tr.className = "today";
    tr.innerHTML = `<td>${day.date}</td><td>${formatNum(day.inputTokens)}</td><td>${formatNum(
      day.outputTokens
    )}</td><td>${formatNum(day.searchQueries)}</td><td>${formatKrw(day.estimatedCostKrw)}</td>`;
    tbody.appendChild(tr);

    totalInput += day.inputTokens;
    totalOutput += day.outputTokens;
    totalSearch += day.searchQueries;
    totalCost += day.estimatedCostKrw;
  }
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  tfoot.innerHTML = `<tr><td>합계</td><td>${formatNum(totalInput)}</td><td>${formatNum(
    totalOutput
  )}</td><td>${formatNum(totalSearch)}</td><td>${formatKrw(totalCost)}</td></tr>`;
  table.appendChild(tfoot);

  costBody.appendChild(table);
}

async function refreshCostTracking(): Promise<void> {
  const [days, quota] = await Promise.all([window.costTrackingAPI.getHistory(), window.costTrackingAPI.getSearchQuota()]);
  renderQuota(quota);
  renderTable(days);
}

costCloseBtn.addEventListener("click", () => {
  window.costTrackingAPI.close();
});

window.costTrackingAPI.onOpen(refreshCostTracking);
refreshCostTracking();
