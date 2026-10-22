import express from "express";
import { loadHistory, TurnSource } from "./state";
import { requireAuth } from "./auth";
import { AssistantImage } from "./assistant-types";
import { AvatarState, ChatServiceResult } from "./chat-service";
import { getHealthRecordsForRange, MAX_RECORDS_RANGE_DAYS, HealthRecordCategory } from "./health";
import { readNoteFile, overwriteNoteFile, NOTE_FILES, NoteFileKey } from "./files";

export const HTTP_PORT = 8787;
const DEFAULT_HISTORY_LIMIT = 50;

// Only ever bound to localhost - the public-facing side is Caddy (running
// separately on the PC), reverse-proxying HTTPS on 80/443 to this port. This
// port itself must never be forwarded on the router.
const BIND_HOST = "127.0.0.1";

type HandleUserMessage = (
  text: string,
  source: TurnSource,
  onStateForCaller?: (state: AvatarState) => void,
  attachedImages?: AssistantImage[]
) => Promise<ChatServiceResult>;

// Lets the phone app remotely mirror the desktop tray's own TTS on/off
// control (see index.ts's toggleTts) - the actual use case is muting the
// GPT-SoVITS engine before it can break from GPU contention with something
// like ComfyUI, without needing to be at the desktop to do it.
export interface TtsControl {
  state: () => "off" | "starting" | "on";
  toggle: () => Promise<void>;
}

// Mirrors the desktop avatar's own provider-switch menu so the phone app can
// change which model answers without needing to be at the desktop - same
// "all instances already exist, plain instant set" model as the desktop
// side, see index.ts's setProvider.
export interface ProviderControl {
  get: () => string;
  options: readonly string[];
  set: (name: string) => boolean;
}

// Enforced server-side too, not just via the phone app's picker limit -
// each image is full-resolution base64 (can be several MB), and this is
// primarily a token-cost guard for the vision call, not a payload-size one.
const MAX_ATTACHED_IMAGES = 5;

// Lets the phone app (and Caddy's own health checks) tell "server down" apart
// from "server up but my token is wrong" - deliberately unauthenticated so it
// works before the user has entered a token anywhere.
// Mirrors health.ts's own private date formatter - kept separate rather than
// exported/shared since this is the only non-health route that needs it.
function formatDateLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function registerHealthRoute(app: express.Express): void {
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
}

export function startHttpServer(handleUserMessage: HandleUserMessage, ttsControl: TtsControl, providerControl: ProviderControl): void {
  const app = express();
  // Default 100kb limit is nowhere near enough for a message carrying up to
  // 5 base64-encoded photos.
  app.use(express.json({ limit: "50mb" }));

  registerHealthRoute(app);

  // Streamed as newline-delimited JSON rather than a single response: the
  // model's onStateHint (thinking/searching) already fires multiple times
  // per request server-side, and this is the simplest way to surface those
  // mid-flight to the phone's avatar animation without a second endpoint or
  // an SSE client dependency - each line is either {"type":"state",...} or
  // the final {"type":"result",...}.
  app.post("/api/message", requireAuth, async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const rawImages = req.body?.images;
    let images: AssistantImage[] | undefined;
    if (rawImages !== undefined) {
      if (!Array.isArray(rawImages) || rawImages.length > MAX_ATTACHED_IMAGES) {
        res.status(400).json({ error: `images must be an array of at most ${MAX_ATTACHED_IMAGES}` });
        return;
      }
      const valid = rawImages.every(
        (img) => img && typeof img.data === "string" && typeof img.mediaType === "string"
      );
      if (!valid) {
        res.status(400).json({ error: "each image needs data and mediaType strings" });
        return;
      }
      images = rawImages as AssistantImage[];
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    try {
      const result = await handleUserMessage(
        text,
        "mobile",
        (state) => {
          res.write(JSON.stringify({ type: "state", state }) + "\n");
        },
        images
      );
      res.write(JSON.stringify({ type: "result", ...result }) + "\n");
      res.end();
    } catch (err) {
      console.error("HTTP /api/message failed:", err);
      // Headers (and possibly some state lines) may already be flushed by
      // this point, so a normal status-code error response is no longer
      // possible - an error line in the same stream format is the only way
      // left to tell the client this request failed.
      res.write(JSON.stringify({ type: "error", error: "internal_error" }) + "\n");
      res.end();
    }
  });

  // Mirrors the desktop tray/avatar's own TTS control so the phone can turn
  // the real desktop engine off/on remotely (e.g. before it breaks from GPU
  // contention with ComfyUI) - this is NOT a per-device mute, it's the same
  // single engine every client (desktop and phone alike) shares.
  app.get("/api/tts-state", requireAuth, (_req, res) => {
    res.json({ state: ttsControl.state() });
  });

  // Deliberately NOT awaited: toggling on doesn't resolve until the whole
  // ~7s GPT-SoVITS subprocess boot finishes, and ttsControl.toggle()'s own
  // synchronous portion (up through TtsEngine.start()'s "this.starting =
  // true") already runs before this handler continues - so reading state()
  // right after firing it off (rather than awaiting completion) is what
  // actually lets the phone observe "starting" instead of just seeing
  // "off" the whole time and then jumping straight to "on". The phone is
  // expected to poll /api/tts-state afterward to see it finish.
  app.post("/api/tts-toggle", requireAuth, (_req, res) => {
    ttsControl.toggle().catch((err) => console.error("Remote TTS toggle failed:", err));
    res.json({ state: ttsControl.state() });
  });

  // options is included so the phone app's settings screen never has to
  // hardcode the valid provider list separately from the desktop's own -
  // adding a 5th provider later only needs a change here and in index.ts.
  app.get("/api/provider", requireAuth, (_req, res) => {
    res.json({ provider: providerControl.get(), options: providerControl.options });
  });

  app.post("/api/provider", requireAuth, (req, res) => {
    const name = req.body?.provider;
    if (typeof name !== "string" || !providerControl.set(name)) {
      res.status(400).json({ error: "invalid provider", options: providerControl.options });
      return;
    }
    res.json({ provider: providerControl.get() });
  });

  // Backs the phone app's 건강관리 탭. start/end are YYYY-MM-DD; categories
  // is a comma-separated subset of work/diet/exercise/sleep (all four if
  // omitted). The 30-day cap is enforced here too, not just by the app's own
  // date picker - getHealthRecordsForRange silently clamps rather than
  // erroring, matching queryHealthLogs's existing (AI-tool-facing) behavior.
  const VALID_CATEGORIES = new Set(["work", "diet", "exercise", "sleep"]);
  app.get("/api/health-records", requireAuth, (req, res) => {
    const start = req.query.start;
    const end = req.query.end;
    if (typeof start !== "string" || typeof end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      res.status(400).json({ error: "start and end must be YYYY-MM-DD" });
      return;
    }
    if (end < start) {
      res.status(400).json({ error: "end must not be before start" });
      return;
    }

    const rawCategories = typeof req.query.categories === "string" ? req.query.categories.split(",") : null;
    const categories = new Set<HealthRecordCategory | "work">(
      (rawCategories ?? ["work", "diet", "exercise", "sleep"]).filter((c): c is HealthRecordCategory | "work" =>
        VALID_CATEGORIES.has(c)
      )
    );

    const records = getHealthRecordsForRange(start, end, categories);
    res.json({ ...records, maxRangeDays: MAX_RECORDS_RANGE_DAYS });
  });

  // Backs the phone app's 기록/메모 editor screens. `which` is "record" or
  // "memo" (NOTE_FILES's two keys) - both are readable/writable from here
  // regardless of which one NP itself can only read vs. read+write, since
  // that distinction is about NP's own tool access, not what the owner can
  // do with their own files from their own phone.
  function isNoteFileKey(v: string): v is NoteFileKey {
    return v in NOTE_FILES;
  }

  app.get("/api/notes/:which", requireAuth, (req, res) => {
    const which = req.params.which;
    if (typeof which !== "string" || !isNoteFileKey(which)) {
      res.status(404).json({ error: "unknown note file" });
      return;
    }
    res.json({ content: readNoteFile(which) });
  });

  app.post("/api/notes/:which", requireAuth, (req, res) => {
    const which = req.params.which;
    if (typeof which !== "string" || !isNoteFileKey(which)) {
      res.status(404).json({ error: "unknown note file" });
      return;
    }
    const content = req.body?.content;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    const result = overwriteNoteFile(which, content);
    if (!result.ok) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json({ ok: true });
  });

  // Backs the phone app's 이전 대화 검색 screen (date-range mode) as well as
  // its original limit-based use (desktop chat window's initial preload).
  // Both share this one route since they're the same underlying resource -
  // start/end just switches the query shape, same as /api/health-records.
  const MAX_HISTORY_RANGE_DAYS = 30;
  app.get("/api/history", requireAuth, (req, res) => {
    const { start, end } = req.query;
    if (typeof start === "string" || typeof end === "string") {
      if (typeof start !== "string" || typeof end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        res.status(400).json({ error: "start and end must both be YYYY-MM-DD" });
        return;
      }
      if (end < start) {
        res.status(400).json({ error: "end must not be before start" });
        return;
      }
      const daysBetween = Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000);
      const cappedEnd =
        daysBetween > MAX_HISTORY_RANGE_DAYS
          ? formatDateLocal(new Date(`${start}T00:00:00`).getTime() + MAX_HISTORY_RANGE_DAYS * 86400000)
          : end;
      const turns = loadHistory().filter((t) => {
        const d = formatDateLocal(t.timestamp);
        return d >= start && d <= cappedEnd;
      });
      res.json({ turns, maxRangeDays: MAX_HISTORY_RANGE_DAYS });
      return;
    }

    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_HISTORY_LIMIT;
    const turns = loadHistory().slice(-limit);
    res.json({ turns });
  });

  app.listen(HTTP_PORT, BIND_HOST, () => {
    console.log(`[http] API server listening on http://${BIND_HOST}:${HTTP_PORT}`);
  });
}
