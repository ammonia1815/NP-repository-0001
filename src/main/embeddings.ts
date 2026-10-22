import { GoogleGenAI } from "@google/genai";

// A separate, minimal Gemini client used only for embeddings - kept apart
// from gemini.ts's chat client so this module has no dependency on which
// provider (Gemini or Claude) is currently active for live chat. Embedding
// text has nothing to do with which model is generating replies.
// "text-embedding-004" (the model named in @google/genai's own JSDoc examples)
// has since been retired - confirmed via a live models.list() call, which
// returned gemini-embedding-001/-2/-2-preview as the current embedContent-
// capable models. Using the stable (non-preview) latest.
const EMBEDDING_MODEL = "gemini-embedding-2";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI | null {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  client = new GoogleGenAI({ apiKey });
  return client;
}

export function embeddingModelName(): string {
  return EMBEDDING_MODEL;
}

// The API rejects anything over 100 contents in one embedContent call
// ("at most 100 requests can be in one batch") - confirmed by hitting that
// exact error once the undreamed backlog grew past 100 turns. Chunking here
// means every caller (warmBacklogEmbeddingCache included) can keep passing
// an arbitrarily large batch without needing to know about this limit.
const MAX_BATCH_SIZE = 100;

async function embedBatch(c: GoogleGenAI, texts: string[]): Promise<(number[] | null)[]> {
  try {
    // A bare array of strings is NOT treated as N independent documents to
    // embed - confirmed by direct testing, it comes back as a single
    // embedding (the strings are read as multiple parts of one content
    // item). Each text must be its own Content object for embedContent to
    // return one vector per input, in order.
    const contents = texts.map((text) => ({ parts: [{ text }] }));
    const response = await c.models.embedContent({ model: EMBEDDING_MODEL, contents });
    const embeddings = response.embeddings ?? [];
    return texts.map((_, i) => embeddings[i]?.values ?? null);
  } catch (err) {
    console.error("Embedding request failed:", err);
    return texts.map(() => null);
  }
}

// Embeds any number of texts, splitting into <=100-item chunks as needed.
// Returns one vector per input, in the same order - entries are null
// wherever that item's chunk failed, so a caller can skip anything it
// couldn't embed without special-casing errors per item. Never throws.
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const c = getClient();
  if (!c) return texts.map(() => null);

  const results: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
    results.push(...(await embedBatch(c, chunk)));
  }
  return results;
}

export async function embedText(text: string): Promise<number[] | null> {
  const [result] = await embedTexts([text]);
  return result;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
