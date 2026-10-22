import * as fs from "fs";
import * as path from "path";

// Lives at the project root (like config.json), not the userData dir - this
// is a tracked persona document, not per-install runtime state.
const PROFILE_PATH = path.join(__dirname, "..", "..", "엔피_주인_프로필.txt");
// Versioned backups live in their own folder rather than a single rotating
// `.bak` - confirmed for real that a single backup slot made it impossible
// to tell how many times the dream cycle had actually rewritten this file
// between two points in time, or see what any edit before the most recent
// one had changed. Text files at this size cost nothing to keep in full.
const BACKUP_DIR = path.join(__dirname, "..", "..", "엔피_주인_프로필_backups");

export function loadUserProfile(): string | null {
  try {
    return fs.readFileSync(PROFILE_PATH, "utf-8");
  } catch {
    return null;
  }
}

function backupTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Saves a timestamped copy of whatever was there BEFORE this overwrite - an
// AI-authored rewrite of this always-on persona block could plausibly
// introduce a wrong or fabricated fact, so every version stays recoverable
// and diffable, not just the one immediately prior.
export function saveUserProfile(newContent: string): void {
  const current = loadUserProfile();
  if (current !== null) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `${backupTimestamp(new Date())}.txt`);
    fs.writeFileSync(backupPath, current, "utf-8");
  }
  fs.writeFileSync(PROFILE_PATH, newContent, "utf-8");
}
