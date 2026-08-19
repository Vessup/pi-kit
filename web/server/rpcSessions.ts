import { dirname } from "node:path";
import {
  ManagedRpcSession,
  type ManagedRpcSessionOptions,
} from "./managed-rpc-session.js";
import type { SessionFileCatalog } from "./server-types.js";
import type { WebServerConfig } from "./serverConfig.js";

/**
 * Creates RPC sessions bound to this daemon's runtime directory. All managed
 * sessions and ad-hoc saved-session commands share this factory.
 */
export function createRpcSessionFactory(options: {
  config: WebServerConfig;
  catalog: SessionFileCatalog;
}) {
  const { config, catalog } = options;
  const { parseSessionMetadataFile } = catalog;

  function createRpcSession(
    options_: Omit<
      ManagedRpcSessionOptions,
      "runtimeDirectory" | "replacementForSessionFile"
    >,
  ): ManagedRpcSession {
    return new ManagedRpcSession({
      ...options_,
      runtimeDirectory: dirname(config.stateFilePath),
      replacementForSessionFile: (file) =>
        parseSessionMetadataFile(file)?.replacement,
    });
  }

  return { createRpcSession };
}

export type RpcSessionFactory = ReturnType<typeof createRpcSessionFactory>;
