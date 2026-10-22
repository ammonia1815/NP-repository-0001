import * as fs from "fs";
import * as path from "path";

// The ONLY directory the assistant is allowed to look into. Everything below resolves
// paths against this root and refuses anything that would escape it (via "..", absolute
// paths, symlinks, etc.). Browsing/reading here covers the whole folder (listFiles/
// readFileSafe/readFilesSafe below); writing is deliberately NOT a generic
// arbitrary-path capability - only the two named note files below (NOTE_FILES) can ever
// be written to, each through its own narrow function, never a free-form path.
const ALLOWED_ROOT = path.resolve(__dirname, "..", "..", "엔피 조회 가능 자료");

const MAX_TEXT_BYTES = 100_000;
const MAX_IMAGE_BYTES = 8_000_000;

// record: NP both reads and writes this (only when the user explicitly asks
// something to be recorded - important conversations, plans, code, etc.).
// memo: NP only ever reads this - the user's own running notes, written by
// hand (desktop: just drop/edit the file; mobile: the 메모 editor screen),
// that NP looks at when asked to.
export const NOTE_FILES = {
  record: "엔피_기록.md",
  memo: "주인_메모.md",
} as const;
export type NoteFileKey = keyof typeof NOTE_FILES;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".log", ".yml", ".yaml"]);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface FileEntry {
  name: string;
  isDirectory: boolean;
}

class PathEscapeError extends Error {}

function resolveSafe(relativePath: string): string {
  const cleaned = relativePath.trim() || ".";
  const resolved = path.resolve(ALLOWED_ROOT, cleaned);
  if (resolved !== ALLOWED_ROOT && !resolved.startsWith(ALLOWED_ROOT + path.sep)) {
    throw new PathEscapeError("허용된 조회 폴더를 벗어난 경로입니다.");
  }
  return resolved;
}

export function listFiles(relativePath = "."): FileEntry[] {
  const dir = resolveSafe(relativePath);
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
}

export type ReadFileResult =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mediaType: string }
  | { kind: "error"; message: string };

// Reads several files in one call, in order - lets the AI request "these 5
// photos" as a single tool round trip instead of one round trip per photo,
// which otherwise would each cost a full extra API call (~9s+) the same way
// any other tool call does.
export function readFilesSafe(relativePaths: string[]): { path: string; result: ReadFileResult }[] {
  return relativePaths.map((p) => ({ path: p, result: readFileSafe(p) }));
}

export function readFileSafe(relativePath: string): ReadFileResult {
  let full: string;
  try {
    full = resolveSafe(relativePath);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }

  if (!fs.existsSync(full)) {
    return { kind: "error", message: "파일을 찾을 수 없습니다." };
  }
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    return { kind: "error", message: "이건 폴더입니다. list_files로 먼저 안의 목록을 확인하세요." };
  }

  const ext = path.extname(full).toLowerCase();
  const imageMediaType = IMAGE_MEDIA_TYPES[ext];
  if (imageMediaType) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { kind: "error", message: `이미지가 너무 큽니다 (${Math.round(stat.size / 1e6)}MB, 최대 8MB).` };
    }
    return { kind: "image", data: fs.readFileSync(full).toString("base64"), mediaType: imageMediaType };
  }

  if (TEXT_EXTENSIONS.has(ext) || ext === "") {
    if (stat.size > MAX_TEXT_BYTES) {
      return { kind: "error", message: `파일이 너무 큽니다 (${Math.round(stat.size / 1024)}KB, 최대 100KB).` };
    }
    return { kind: "text", text: fs.readFileSync(full, "utf-8") };
  }

  return { kind: "error", message: `지원하지 않는 파일 형식입니다 (${ext}).` };
}

// Shared by both the mobile note editor (always overwrites, like any plain
// text editor saving a file) and record()'s own overwrite mode.
function noteFilePath(which: NoteFileKey): string {
  return path.join(ALLOWED_ROOT, NOTE_FILES[which]);
}

export function readNoteFile(which: NoteFileKey): string {
  const full = noteFilePath(which);
  if (!fs.existsSync(full)) return "";
  return fs.readFileSync(full, "utf-8");
}

function writeNoteFileRaw(which: NoteFileKey, content: string): { ok: boolean; message: string } {
  if (Buffer.byteLength(content, "utf-8") > MAX_TEXT_BYTES) {
    return { ok: false, message: `파일이 너무 큽니다 (최대 ${Math.round(MAX_TEXT_BYTES / 1024)}KB).` };
  }
  fs.mkdirSync(ALLOWED_ROOT, { recursive: true });
  fs.writeFileSync(noteFilePath(which), content, "utf-8");
  return { ok: true, message: "저장되었습니다." };
}

// The mobile 메모/기록 editor screens always send the whole new content back
// (a normal text editor's save, not a diff) - used for both note files.
export function overwriteNoteFile(which: NoteFileKey, content: string): { ok: boolean; message: string } {
  return writeNoteFileRaw(which, content);
}

// NP's own write path - "record" ONLY (never "memo", which NP can only ever
// read; there is no function that lets NP write to it). append is the
// default because NP's writes here are conversational/incremental ("이것도
// 기록해줘" added to an existing log), unlike the mobile editor's plain
// overwrite-the-whole-box save.
export function writeRecordFile(content: string, mode: "append" | "overwrite" = "append"): { ok: boolean; message: string } {
  if (mode === "overwrite") {
    return writeNoteFileRaw("record", content);
  }
  const existing = readNoteFile("record");
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const separator = existing.trim().length > 0 ? "\n\n---\n" : "";
  return writeNoteFileRaw("record", `${existing}${separator}[${stamp}]\n${content}\n`);
}
