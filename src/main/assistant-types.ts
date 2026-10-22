import { TurnSource } from "./state";

export type Emotion = "idle" | "happy" | "sad" | "thinking" | "surprised";

export const EMOTIONS: Emotion[] = ["idle", "happy", "sad", "thinking", "surprised"];

export interface AssistantReply {
  reply: string;
  emotion: Emotion;
}

export interface AssistantImage {
  data: string;
  mediaType: string;
}

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

// Owned by index.ts and passed into whichever provider is active, instead of
// each Assistant implementation keeping its own private session history -
// otherwise switching providers mid-conversation (the provider toggle) would
// make the newly-active one blind to everything just said to the other one.
export interface ConversationSession {
  turns: SessionTurn[];
  startedAt: number;
}

// "searching" means a live web-search call is genuinely in flight right now
// (confirmed via streaming step events, not guessed) - only Gemini currently
// reports this; other providers simply never call onStateHint and the avatar
// stays on its normal "thinking" animation for the whole wait.
export type AssistantStateHint = "thinking" | "searching";

export interface Assistant {
  isReady(): boolean;
  send(
    userText: string,
    session: ConversationSession,
    idleGapMs: number,
    source: TurnSource,
    images?: AssistantImage[],
    onStateHint?: (state: AssistantStateHint) => void
  ): Promise<AssistantReply>;
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    emotion: { type: "string", enum: EMOTIONS },
  },
  required: ["reply", "emotion"],
  additionalProperties: false,
};
