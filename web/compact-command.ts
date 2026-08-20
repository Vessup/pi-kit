import type { WebSlashCommand } from "./protocol.js";

export const WEB_COMPACT_EXTENSION_COMMAND = "web-compact";

export const WEB_COMPACT_COMMAND: WebSlashCommand = {
  name: "compact",
  description: "Compact the current session context",
  source: "extension",
  location: "temporary",
};

export type WebCompactCommand = { customInstructions?: string };

/** Parse Pi Web's built-in compact command without matching prose or prefixes. */
export function parseWebCompactCommand(
  text: string,
): WebCompactCommand | undefined {
  const match = text.match(/^\/compact(?:\s+([\s\S]*?))?\s*$/);
  if (!match) return undefined;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}

/** Keep compact visible while connected to stale native command metadata. */
export function includeWebCompactCommand(
  commands: WebSlashCommand[],
): WebSlashCommand[] {
  return commands.some((command) => command.name === "compact")
    ? commands
    : [WEB_COMPACT_COMMAND, ...commands];
}
