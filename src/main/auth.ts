import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { loadSettings, saveSettings } from "./state";

// A long random token, self-issued on first run and reused thereafter -
// this app is directly reachable from the public internet via the user's
// own port-forwarding, so every non-health-check request must prove it
// holds this token. There is no user/password system since this is a
// single-user app; the token stands in for that.
export function getOrCreateApiToken(): string {
  const settings = loadSettings();
  if (settings.apiToken) return settings.apiToken;
  const token = crypto.randomBytes(32).toString("hex");
  saveSettings({ ...settings, apiToken: token });
  return token;
}

// Constant-time comparison so a timing side-channel can't help an attacker
// guess the token one byte at a time.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const match = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
  const expected = getOrCreateApiToken();
  const provided = match?.[1] ?? "";

  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
