import type { ClientPromptMessage } from "../protocol";

export const MAX_CLIENT_PROMPT_PAYLOAD_BYTES = 32 * 1024 * 1024;

export function clientPromptPayloadBytes(prompt: ClientPromptMessage): number {
  return new TextEncoder().encode(JSON.stringify(prompt)).byteLength;
}

/** Validate the complete frame, including prompt text, image metadata, and JSON framing. */
export function assertClientPromptPayloadFits(prompt: ClientPromptMessage): void {
  if (clientPromptPayloadBytes(prompt) > MAX_CLIENT_PROMPT_PAYLOAD_BYTES) {
    throw new Error("Prompt and attachments exceed the 32 MB WebSocket payload limit");
  }
}
