import type { Innertube } from "youtubei.js";
import { YoutubeTranscript } from "youtube-transcript";

export interface YoutubeInfo {
  title: string | null;
  channel: string | null;
  durationSeconds: number | null;
  description: string | null;
  transcript: string | null;
  comments: string[];
}

const URL_PATTERNS = [
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/watch\?[^ ]*v=([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

export function extractYoutubeVideoId(urlOrText: string): string | null {
  for (const pattern of URL_PATTERNS) {
    const match = urlOrText.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// youtubei.js ships ESM-only. A plain `await import(...)` here would seem
// like the fix, but tsc's CommonJS output down-levels that to a
// Promise-wrapped require() (confirmed by reading the compiled JS), which
// hits the exact same ERR_REQUIRE_ESM crash as a static import - require()
// genuinely cannot load an ESM-only package no matter how it's dressed up.
// The `new Function(...)` indirection below is a deliberate escape hatch
// that stops tsc from rewriting the import at compile time, so this becomes
// a real native dynamic import at runtime (confirmed fixed the crash).
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("youtubei.js")>;

// Innertube.create() does its own handshake/session setup - worth reusing
// across calls within the process rather than redoing it on every lookup.
let cachedClient: Innertube | null = null;
async function getClient(): Promise<Innertube> {
  if (!cachedClient) {
    const { Innertube } = await dynamicImport("youtubei.js");
    cachedClient = await Innertube.create();
  }
  return cachedClient;
}

// Each of the three sources (metadata, transcript, comments) is fetched
// through its own try/catch and allowed to independently fail - confirmed
// for real that youtubei.js's own getTranscript() (and even a direct fetch
// of the signed caption base_url) can silently return nothing for a video
// that genuinely has captions, so transcript specifically goes through the
// separate youtube-transcript package instead, which worked reliably in
// testing where both youtubei.js paths didn't. Metadata and comments still
// use youtubei.js (both confirmed working there). None of this is Gemini's
// native video/audio understanding - it's text-only (title, description,
// transcript, comments), so formatYoutubeInfoForModel below is explicit
// about that gap when the gathered info is too thin to say anything useful.
export async function fetchYoutubeInfo(videoId: string): Promise<YoutubeInfo> {
  let title: string | null = null;
  let channel: string | null = null;
  let durationSeconds: number | null = null;
  let description: string | null = null;
  let comments: string[] = [];

  try {
    const yt = await getClient();
    const info = await yt.getInfo(videoId);
    title = info.basic_info.title ?? null;
    channel = info.basic_info.channel?.name ?? null;
    durationSeconds = info.basic_info.duration ?? null;
    description = info.basic_info.short_description || null;
  } catch (err) {
    console.error("YouTube metadata fetch failed:", err);
  }

  let transcript: string | null = null;
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (segments.length > 0) transcript = segments.map((s) => s.text).join(" ");
  } catch (err) {
    console.error("YouTube transcript fetch failed:", err);
  }

  try {
    const yt = await getClient();
    const result = await yt.getComments(videoId);
    comments = (result.contents ?? [])
      .slice(0, 10)
      .map((c) => {
        const anyC = c as unknown as { comment?: { content?: { text?: string } }; content?: { text?: string } };
        return anyC.comment?.content?.text ?? anyC.content?.text;
      })
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch (err) {
    console.error("YouTube comments fetch failed:", err);
  }

  return { title, channel, durationSeconds, description, transcript, comments };
}

// Caps the transcript specifically (not description/comments, which are
// already naturally short) since a long video's full transcript could
// otherwise dwarf everything else in the context.
const MAX_TRANSCRIPT_CHARS = 6000;

export function formatYoutubeInfoForModel(info: YoutubeInfo): string {
  const parts: string[] = [];
  if (info.title) parts.push(`제목: ${info.title}`);
  if (info.channel) parts.push(`채널: ${info.channel}`);
  if (info.durationSeconds) {
    const m = Math.floor(info.durationSeconds / 60);
    const s = info.durationSeconds % 60;
    parts.push(`길이: ${m}분 ${s}초`);
  }
  if (info.description) parts.push(`설명: ${info.description.slice(0, 500)}`);
  if (info.transcript) {
    const capped =
      info.transcript.length > MAX_TRANSCRIPT_CHARS
        ? `${info.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}...(자막 길이 제한으로 이하 생략)`
        : info.transcript;
    parts.push(`자막 내용: ${capped}`);
  }
  if (info.comments.length > 0) {
    parts.push(`주요 댓글:\n${info.comments.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }

  if (!info.transcript && !info.description) {
    parts.push("(자막과 설명 정보를 모두 가져오지 못했습니다 - 이 영상 내용은 파악하기 어렵습니다.)");
  }

  return parts.length > 0 ? parts.join("\n\n") : "이 영상에 대한 정보를 전혀 가져오지 못했습니다.";
}
