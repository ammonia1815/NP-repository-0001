import { ChildProcess, spawn } from "child_process";

const RVC_SERVER_ROOT = "D:\\AI models\\RVC";
const PYTHON_EXEC = `${RVC_SERVER_ROOT}\\venv\\Scripts\\python.exe`;
const SERVER_SCRIPT = "np_tts_server.py";
const PORT = 9885;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Replaces the old GPT-SoVITS pipeline: GPT-SoVITS's Korean pronunciation
// stayed "foreign-accented" no matter how much it was fine-tuned on Korean
// data (confirmed via a full RVC-bootstrapped retrain attempt that came out
// worse than the original). np_tts_server.py instead chains Supertonic
// (genuinely native Korean pronunciation) through RVC (re-skins the result
// with the existing himari/kiritan timbre) - both the pronunciation fixes
// and reference-voice handling now live inside that server, not here.

// If the TTS subprocess dies (e.g. a CUDA error from GPU contention with
// another local process) more than this many times within the window, stop
// auto-restarting and just leave TTS off - otherwise a subprocess that
// crashes instantly on every launch would spawn in a tight infinite loop.
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 3;

export class TtsEngine {
  private process: ChildProcess | null = null;
  private enabled = false;
  private starting = false;
  private stoppingIntentionally = false;
  private crashTimestamps: number[] = [];

  // Notified only around the auto-restart path below (the manual toggle in
  // index.ts already broadcasts state itself around its own start()/stop()
  // calls) - lets the tray/avatar UI reflect a crash-triggered restart too,
  // instead of silently staying stuck on "on" while actually dead.
  constructor(private onAutoRestartStateChange?: (state: "off" | "starting" | "on") => void) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  isStarting(): boolean {
    return this.starting;
  }

  async start(): Promise<void> {
    if (this.process || this.starting) return;
    this.starting = true;
    this.enabled = true;

    this.process = spawn(PYTHON_EXEC, [SERVER_SCRIPT], { cwd: RVC_SERVER_ROOT });

    this.process.on("exit", (code, signal) => {
      this.process = null;
      if (this.stoppingIntentionally) {
        this.stoppingIntentionally = false;
        return;
      }
      // The process died on its own (crash, CUDA error, OOM, etc.) rather
      // than via our own stop() - this is exactly the "TTS goes silent until
      // I manually toggle it off/on" symptom, so reproduce that same
      // recovery (a fresh spawn) automatically instead of leaving it dead.
      if (!this.enabled) return;
      console.error(`[tts] process exited unexpectedly (code=${code}, signal=${signal}), auto-restarting`);
      this.handleUnexpectedExit();
    });
    this.process.stderr?.on("data", (chunk) => {
      console.error("[tts]", chunk.toString());
    });
    this.process.stdout?.on("data", (chunk) => {
      console.log("[tts]", chunk.toString());
    });

    await this.waitUntilReady();
    this.starting = false;
  }

  private handleUnexpectedExit(): void {
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length > CRASH_LOOP_MAX) {
      console.error("[tts] crashed repeatedly in a short window - giving up auto-restart, leaving TTS off");
      this.enabled = false;
      this.onAutoRestartStateChange?.("off");
      return;
    }

    this.onAutoRestartStateChange?.("starting");
    this.start()
      .then(() => this.onAutoRestartStateChange?.("on"))
      .catch((err) => {
        console.error("[tts] auto-restart failed:", err);
        this.enabled = false;
        this.onAutoRestartStateChange?.("off");
      });
  }

  stop(): void {
    this.enabled = false;
    if (this.process) {
      this.stoppingIntentionally = true;
      this.process.kill();
      this.process = null;
    }
  }

  // Supertonic + RVC model loading (both loaded once at process startup, not
  // per-request) takes noticeably longer than GPT-SoVITS's old startup did -
  // give it real headroom instead of timing out mid-load.
  private async waitUntilReady(timeoutMs = 180000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("TTS server did not become ready in time");
  }

  async synthesize(text: string): Promise<Buffer | null> {
    if (!this.enabled || !this.process) return null;

    const params = new URLSearchParams();
    params.set("text", text);

    try {
      // Node's default fetch timeout is 5 minutes - when the TTS server stalls
      // (e.g. GPU contention from another local process actively generating,
      // like ComfyUI/MiniMax video gen), that meant waiting the full 5 minutes
      // before giving up. Normal synthesis for a long reply can legitimately
      // reach the high-teens in seconds, so 30s gives real headroom above that
      // while still failing fast instead of blocking the reply for minutes.
      const res = await fetch(`${BASE_URL}/tts?${params.toString()}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.error("TTS request failed:", res.status, await res.text());
        return null;
      }
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error("TTS request error:", err);
      return null;
    }
  }
}
