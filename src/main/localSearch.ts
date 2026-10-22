import * as cheerio from "cheerio";

export interface WebSearchResult {
  title: string;
  snippet: string;
  link: string;
}

// Perplexity's Search API (api.perplexity.ai/search) - paid, flat
// $0.005/query, no free tier. Replaced the earlier DuckDuckGo HTML-scraping
// approach: DDG had no official API, was fragile (a real CAPTCHA bot-block
// triggered by normal conversation traffic, not just testing), and a
// no-site:-operator plain query still only returns thin snippets. Deliberately
// only used on the local-model path - Gemini/Claude already have their own
// paid search tools - so the free local chat path isn't left with zero search
// capability.
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const MAX_RESULTS = 6;

// Requested from Perplexity (more than MAX_RESULTS) so the dedup pass below
// still has enough distinct documents left to fill MAX_RESULTS after
// collapsing near-duplicates - see dedupeByCanonicalUrl's own comment for why
// that collapsing is needed in the first place. 15 is comfortably under the
// API's documented max (20 for "web" search_type).
const RAW_FETCH_COUNT = 15;

interface PerplexitySearchResponse {
  results?: { title: string; url: string; snippet: string }[];
}

// Confirmed for real against the live API: for a Korean niche-wiki topic
// (Limbus Company on namu.wiki), several of the top 6 raw results were the
// SAME article at different edit revisions (namu.wiki's own revision-diff
// URLs, distinguished only by a "?uuid=..." query param) - e.g. 4 of 6 slots
// for one query were "(r578 판)", "(r605 판)", "(r607 판)", "(r598 판)" of the
// identical page, crowding out more specific sub-pages (like a chapter's own
// article) that would otherwise have ranked in. Globally-documented topics
// (confirmed fine for StarCraft 2 queries) don't hit this because their
// sources (Liquipedia, official wikis) don't expose revision history as
// separate crawlable URLs the way namu.wiki does - so this isn't a
// namu.wiki-specific patch, just a generic "strip tracking/revision query
// params and collapse to the canonical document" dedup that happens to fix
// that site's specific symptom.
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function dedupeByCanonicalUrl(results: WebSearchResult[]): WebSearchResult[] {
  const groups = new Map<string, WebSearchResult[]>();
  for (const r of results) {
    const key = canonicalUrl(r.link);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const deduped: WebSearchResult[] = [];
  for (const group of groups.values()) {
    // Prefer the query-string-free (live, canonical) URL within a group of
    // duplicates over a revision-snapshot one, when both ranked - the
    // snapshot's content is the same article anyway, but its title/URL
    // (e.g. "...(r578 판)") is just revision-history noise for the model.
    deduped.push(group.find((r) => !r.link.includes("?")) ?? group[0]);
  }
  return deduped.slice(0, MAX_RESULTS);
}

async function perplexitySearchOnce(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error("PERPLEXITY_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
  }
  const res = await fetch(PERPLEXITY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, max_results: RAW_FETCH_COUNT }),
  });
  if (!res.ok) {
    throw new Error(`Perplexity 검색 실패: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as PerplexitySearchResponse;
  const results = (data.results ?? []).map((r) => ({ title: r.title, snippet: r.snippet, link: r.url }));
  return dedupeByCanonicalUrl(results);
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
  return perplexitySearchOnce(query);
}

export function formatSearchResultsForModel(results: WebSearchResult[]): string {
  if (results.length === 0) return "검색 결과가 없습니다.";
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n(${r.link})`).join("\n\n");
}

// Caps how much of a fetched page's plain text gets handed to the model -
// otherwise a single long wiki article could dwarf everything else in
// context the same way an uncapped YouTube transcript could (see
// localYoutube.ts's own MAX_TRANSCRIPT_CHARS).
const MAX_PAGE_CHARS = 6000;

// How many occurrences of a single keyword to score - without this cap, a
// generic word that repeats constantly through a long article (e.g. the
// series name) would make scoring itself slow for no benefit, since matches
// past the first few dozen aren't meaningfully more informative.
const MAX_OCCURRENCES_PER_KEYWORD = 50;

// A search result's snippet is often too shallow to contain the actual fact
// a long wiki article buries deep in its body (confirmed for real: a
// specific plot detail sat ~240,000 characters into a ~750,000-character
// namu.wiki article - no snippet could ever have surfaced it, and a blind
// truncation from the top of the page wouldn't reach it either).
//
// Two earlier versions of this function tried to guess the right spot by
// scanning the WHOLE body for query keywords - first anchoring on whichever
// keyword matched earliest (broke on a chapter-number keyword matching the
// page's own title/breadcrumb near the top), then on whichever spot had the
// most keywords clustered nearby (broke the OTHER way: confirmed for real
// that a meta-discussion/review section repeated all the generic query terms
// - series name, chapter number - densely, scoring higher than the actual
// narrative passage, which told the story through character names and never
// repeated words like "엔딩" or "아타락시아" at all). Keyword density inside
// body text just doesn't track relevance reliably either direction.
//
// What does track reliably: namu.wiki (like most wikis) renders a real
// heading element per section, and a heading's own text is short and
// precise ("2.2.1. 상편 : A엔딩 ATARAXIE") - confirmed by inspecting the raw
// HTML. So this matches keywords against HEADINGS first and, on a hit,
// returns exactly that section's own text (from this heading up to the
// next one) - no density competition with unrelated sections, because
// unrelated sections' text is excluded entirely rather than merely
// outscored. Falls back to the old clustering scan only for pages with no
// headings at all (forum posts, blogs).
export async function fetchPageText(url: string, query?: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`페이지 요청 실패: ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const headingTexts: string[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) headingTexts.push(t);
  });
  const text = $("body").text().replace(/\s+/g, " ").trim();

  if (text.length <= MAX_PAGE_CHARS) return text;

  if (query) {
    const keywords = Array.from(new Set(query.split(/\s+/).filter((k) => k.length > 1 && !k.startsWith("site:"))));

    // A bare single letter (e.g. "A" from "A 엔딩") was tried here instead of
    // this compound and had to be reverted - confirmed for real that it
    // matches a letter ANYWHERE, including inside an unrelated heading's
    // English title ("B엔딩 BON APPÉTIT" also contains "A"), which tied two
    // different endings' headings at the same score and let the wrong one
    // win on the later-wins tiebreak below. Building the exact compound
    // ("A엔딩") instead only matches the one heading that actually names
    // that specific ending.
    const endingLetterMatches = query.match(/[A-Za-z]\s*엔딩/g) ?? [];
    for (const m of endingLetterMatches) {
      const compound = m.replace(/\s+/g, "");
      if (!keywords.includes(compound)) keywords.push(compound);
    }

    if (headingTexts.length > 0) {
      let bestHeadingIdx = -1;
      let bestHeadingScore = 0;
      headingTexts.forEach((h, i) => {
        const score = keywords.filter((kw) => h.includes(kw)).length;
        // >= rather than > - confirmed for real that the page's own title
        // (always the FIRST heading) often ties with the real content
        // section on a generic keyword like a chapter number (both match
        // "10장"), and a strict > tie-break always kept that first, wrong
        // match. The actual content heading is essentially always later in
        // the document, so on a tie this keeps the later, more specific one.
        if (score > 0 && score >= bestHeadingScore) {
          bestHeadingScore = score;
          bestHeadingIdx = i;
        }
      });

      if (bestHeadingIdx !== -1) {
        // Locates each heading's position in the flattened text via a
        // rolling cursor (searching forward from the previous heading's own
        // position) so document order stays correct even if a heading's
        // exact text happens to repeat verbatim somewhere else on the page.
        let cursor = 0;
        const positions: number[] = [];
        for (const h of headingTexts) {
          const idx = text.indexOf(h, cursor);
          positions.push(idx === -1 ? cursor : idx);
          if (idx !== -1) cursor = idx + h.length;
        }
        const sectionStart = positions[bestHeadingIdx];
        const sectionEnd = bestHeadingIdx + 1 < positions.length ? positions[bestHeadingIdx + 1] : text.length;
        const section = text.slice(sectionStart, sectionEnd).trim();
        if (section.length > 0) {
          return section.length > MAX_PAGE_CHARS
            ? `${section.slice(0, MAX_PAGE_CHARS)}...(섹션 길이 제한으로 이하 생략)`
            : section;
        }
      }
    }

    const half = Math.floor(MAX_PAGE_CHARS / 2);
    let bestPos = -1;
    let bestScore = -1;
    for (const kw of keywords) {
      let searchFrom = 0;
      let occurrences = 0;
      let idx: number;
      while (occurrences < MAX_OCCURRENCES_PER_KEYWORD && (idx = text.indexOf(kw, searchFrom)) !== -1) {
        occurrences++;
        searchFrom = idx + kw.length;
        const nearby = text.slice(Math.max(0, idx - half), Math.min(text.length, idx + half));
        const score = keywords.filter((other) => nearby.includes(other)).length;
        if (score > bestScore || (score === bestScore && idx > bestPos)) {
          bestScore = score;
          bestPos = idx;
        }
      }
    }
    if (bestPos !== -1) {
      const start = Math.max(0, bestPos - half);
      const end = Math.min(text.length, start + MAX_PAGE_CHARS);
      const prefix = start > 0 ? "...(앞부분 생략)...\n" : "";
      const suffix = end < text.length ? "\n...(이하 생략)..." : "";
      return `${prefix}${text.slice(start, end)}${suffix}`;
    }
  }

  return `${text.slice(0, MAX_PAGE_CHARS)}...(페이지 길이 제한으로 이하 생략 - 검색어 키워드를 본문에서 찾지 못해 앞부분만 반환됨)`;
}
