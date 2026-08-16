import type { WebSlashCommand } from "./protocol.js";

export const WEB_RELOAD_COMMAND: WebSlashCommand = {
  name: "reload",
  description: "Reload extensions, skills, prompts, themes, and context files",
  source: "extension",
  location: "temporary",
};

/** Match only Pi's argument-free built-in reload command. */
export function isWebReloadCommand(text: string): boolean {
  return /^\/reload\s*$/.test(text);
}

/** Keep reload client-visible even while connected to a pre-reload native bridge. */
export function includeWebReloadCommand(
  commands: WebSlashCommand[],
): WebSlashCommand[] {
  const visible = commands.filter((command) => command.name !== "web-reload");
  return visible.some((command) => command.name === "reload")
    ? visible
    : [WEB_RELOAD_COMMAND, ...visible];
}
