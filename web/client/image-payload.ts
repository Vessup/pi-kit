import type { ClientPromptMessage, SemanticImage } from "../protocol";

export const MAX_CLIENT_PROMPT_PAYLOAD_BYTES = 32 * 1024 * 1024;

function jsonStringBytes(value: string): number {
  let bytes = 2; // Surrounding quotes.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function semanticImagePayloadBytes(image: SemanticImage): number {
  let bytes = 2;
  let fields = 0;
  const addString = (key: string, value: string) => {
    bytes += (fields++ > 0 ? 1 : 0) + jsonStringBytes(key) + 1 + jsonStringBytes(value);
  };
  addString("type", image.type);
  addString("data", image.data);
  addString("mimeType", image.mimeType);
  if (image.name !== undefined) addString("name", image.name);
  return bytes;
}

export function clientPromptPayloadBytes(prompt: ClientPromptMessage): number {
  let bytes = 2;
  let fields = 0;
  const addField = (key: string, valueBytes: number) => {
    bytes += (fields++ > 0 ? 1 : 0) + jsonStringBytes(key) + 1 + valueBytes;
  };
  addField("type", jsonStringBytes(prompt.type));
  addField("requestId", jsonStringBytes(prompt.requestId));
  addField("sessionId", jsonStringBytes(prompt.sessionId));
  addField("message", jsonStringBytes(prompt.message));
  if (prompt.images !== undefined) {
    const imagesBytes = 2 + prompt.images.reduce(
      (total, image, index) => total + (index > 0 ? 1 : 0) + semanticImagePayloadBytes(image),
      0,
    );
    addField("images", imagesBytes);
  }
  if (prompt.streamingBehavior !== undefined) addField("streamingBehavior", jsonStringBytes(prompt.streamingBehavior));
  return bytes;
}

/** Validate the complete frame, including prompt text, image metadata, and JSON framing. */
export function assertClientPromptPayloadFits(prompt: ClientPromptMessage): void {
  if (clientPromptPayloadBytes(prompt) > MAX_CLIENT_PROMPT_PAYLOAD_BYTES) {
    throw new Error(`Prompt and attachments exceed the ${MAX_CLIENT_PROMPT_PAYLOAD_BYTES / (1024 * 1024)} MiB WebSocket payload limit`);
  }
}
