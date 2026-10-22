import * as fs from "fs";
import * as path from "path";

export interface AppConfig {
  provider: "anthropic" | "gemini";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  geminiModel: string;
  // Served locally via Ollama (http://localhost:11434) - a third, zero-API-cost
  // provider alongside Gemini/Claude, scoped to plain chit-chat only (no
  // tools/search/images - see local.ts).
  localModel: string;
  assistantName: string;
  systemPrompt: string;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const configPath = path.join(__dirname, "..", "..", "config.json");
  cached = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return cached as AppConfig;
}
