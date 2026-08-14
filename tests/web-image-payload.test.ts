import { expect, test } from "bun:test";
import {
	assertClientPromptPayloadFits,
	clientPromptPayloadBytes,
	MAX_CLIENT_PROMPT_PAYLOAD_BYTES,
} from "../web/client/image-payload.ts";
import type { ClientPromptMessage, SemanticImage } from "../web/protocol.ts";

const encodedTenMiB = Math.ceil((10 * 1024 * 1024) / 3) * 4;
const image = (): SemanticImage => ({ type: "image", mimeType: "image/png", data: "a".repeat(encodedTenMiB) });

function prompt(message: string, images: SemanticImage[]): ClientPromptMessage {
	return {
		type: "client.prompt",
		requestId: "00000000-0000-4000-8000-000000000000",
		sessionId: "session",
		message,
		images,
	};
}

test("complete prompt frames keep text and multiple images below the websocket limit", () => {
	const twoImages = prompt("small prompt", [image(), image()]);
	expect(clientPromptPayloadBytes(twoImages)).toBeLessThan(MAX_CLIENT_PROMPT_PAYLOAD_BYTES);
	expect(() => assertClientPromptPayloadFits(twoImages)).not.toThrow();

	const oversized = prompt("x".repeat(6 * 1024 * 1024), twoImages.images ?? []);
	expect(clientPromptPayloadBytes(oversized)).toBeGreaterThan(MAX_CLIENT_PROMPT_PAYLOAD_BYTES);
	expect(() => assertClientPromptPayloadFits(oversized)).toThrow("Prompt and attachments");
});

test("prompt frame accounting uses encoded UTF-8 bytes rather than string length", () => {
	const frame = prompt("🙂", []);
	expect(clientPromptPayloadBytes(frame)).toBe(new TextEncoder().encode(JSON.stringify(frame)).byteLength);
	expect(clientPromptPayloadBytes(frame)).toBeGreaterThan(JSON.stringify(frame).length);
});
