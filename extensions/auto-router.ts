import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
  type ModelRegistry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { classifyTurnComplexity } from "./auto-router-classify.js";
import {
  AutoRouterHealthStore,
  type ClassificationLogEntry,
  type ModelHealthEntry,
  type ModelIdentity,
  modelKey,
} from "./auto-router-health.js";
import { normalizeModelId, reconcileProviderQuota } from "./auto-router-quota.js";
import {
  AUTO_ROUTER_EFFORT_ORDER,
  type AutoRouterEffortLevel,
  type AutoRouterModelRef,
  type AutoRouterSettings,
  allConfiguredModels,
  ensureAutoModelScopedInGlobalSettings,
  escalationTiers,
  readAutoRouterSettings,
  resolveEffortTier,
} from "./auto-router-settings.js";
import {
  FOOTER_CONTRIBUTION_EVENT,
  type FooterContribution,
} from "./footer-events.js";

const AUTO_PROVIDER_ID = "auto";
const AUTO_MODEL_ID = "auto";
const AUTO_ACTIVE_ENTRY_TYPE = "vessup:auto-router:active";
const FOOTER_KEY = "auto-router";

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A `stopReason: "error"` assistant message carries no HTTP status — only a human-readable
 * `errorMessage` (Pi's own normalized wording, e.g. "Codex error: The usage limit has been
 * reached"). By the time an extension sees this, Pi's own agent-level retry has already given
 * up against this exact model/provider, so any such error is treated as at least as serious as
 * a rate limit (immediate cooldown) rather than requiring several occurrences first.
 */
function inferFailureStatus(errorMessage: string | undefined): number {
  const text = (errorMessage ?? "").toLowerCase();
  if (/unauthoriz|authentication|invalid api key|forbidden/.test(text)) return 401;
  return 429;
}

/** Resolve config model refs to real, currently-usable `Model` objects (auth configured), preserving order. */
function resolveAvailableModels(
  modelRegistry: ModelRegistry,
  refs: AutoRouterModelRef[],
): Model<Api>[] {
  const models: Model<Api>[] = [];
  for (const ref of refs) {
    const model = modelRegistry.find(ref.provider, ref.id);
    if (model && modelRegistry.hasConfiguredAuth(model)) models.push(model);
  }
  return models;
}

function restoreAutoActive(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === AUTO_ACTIVE_ENTRY_TYPE
    ) {
      const data = entry.data;
      return isRecord(data) && data.enabled === true;
    }
  }
  return false;
}

function formatTier(tier: AutoRouterEffortLevel): string {
  return tier;
}

function footerBadge(tier: AutoRouterEffortLevel | undefined): string {
  return tier ? `🔀 Auto (${formatTier(tier)})` : "🔀 Auto";
}

export default function autoRouter(pi: ExtensionAPI): void {
  pi.registerProvider(AUTO_PROVIDER_ID, {
    name: "Auto",
    // Never actually dispatched to: `before_agent_start` always swaps to a real
    // routed model before any request would be sent here.
    baseUrl: "http://127.0.0.1:0",
    apiKey: "auto-router",
    api: "openai-completions",
    models: [
      {
        id: AUTO_MODEL_ID,
        name: "Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });

  let currentSessionId: string | undefined;
  let autoActive = false;
  let routingInFlight = false;
  let lastKnownTier: AutoRouterEffortLevel | undefined;
  const healthStore = new AutoRouterHealthStore();

  function publishFooter(tier: AutoRouterEffortLevel | undefined): void {
    if (!currentSessionId) return;
    pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
      sessionId: currentSessionId,
      key: FOOTER_KEY,
      identitySuffix: (theme: Theme) => theme.fg("accent", footerBadge(tier)),
    } satisfies FooterContribution);
  }

  /** Swap `ctx.model` back to the inert "auto" placeholder once a turn is fully done, so `/model` keeps showing Auto selected (not whichever real model just handled the turn) between turns. */
  async function revertToAutoPlaceholder(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
  ): Promise<void> {
    const placeholder = ctx.modelRegistry.find(AUTO_PROVIDER_ID, AUTO_MODEL_ID);
    if (!placeholder) return;
    routingInFlight = true;
    try {
      await pi.setModel(placeholder);
    } finally {
      routingInFlight = false;
    }
  }

  function clearFooter(): void {
    if (!currentSessionId) return;
    pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
      sessionId: currentSessionId,
      key: FOOTER_KEY,
      remove: true,
    } satisfies FooterContribution);
  }

  /** Pick the best available (resolved + healthy) model for `tier`, escalating to higher configured tiers when everything in `tier` is unhealthy, then falling back to the first available model anywhere as a last resort. */
  function pickForTier(
    ctx: ExtensionContext,
    settings: AutoRouterSettings,
    tier: AutoRouterEffortLevel,
  ): { model: Model<Api>; tier: AutoRouterEffortLevel } | undefined {
    for (const candidateTier of [tier, ...escalationTiers(settings, tier)]) {
      const refs = settings.efforts[candidateTier]?.models ?? [];
      const available = resolveAvailableModels(ctx.modelRegistry, refs);
      const healthy = healthStore.pickHealthy(available);
      if (healthy) {
        const model = available.find(
          (candidate) =>
            candidate.id === healthy.id &&
            candidate.provider === healthy.provider,
        );
        if (model) return { model, tier: candidateTier };
      }
    }
    // Last resort: nothing healthy anywhere. Use the first resolvable model in `tier`,
    // or failing that the first resolvable model anywhere, rather than blocking the turn.
    const fallbackRefs =
      settings.efforts[tier]?.models ?? allConfiguredModels(settings);
    const fallback =
      resolveAvailableModels(ctx.modelRegistry, fallbackRefs)[0] ??
      resolveAvailableModels(
        ctx.modelRegistry,
        allConfiguredModels(settings),
      )[0];
    if (fallback) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto: every configured ${formatTier(tier)} model looks unavailable; using ${fallback.provider}/${fallback.id} anyway. Check /usage.`,
          "warning",
        );
      }
      return { model: fallback, tier };
    }
    // Nothing configured for Auto at all (or resolvable) - the "auto" placeholder has no real
    // backend, so leaving it selected here would send the actual request to it and fail with a
    // connection error instead of a clear message. Fall back to any authenticated model in the
    // whole catalog rather than ever letting a turn run against the placeholder.
    const anyModel = ctx.modelRegistry
      .getAvailable()
      .find((candidate) => candidate.provider !== AUTO_PROVIDER_ID);
    if (anyModel) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto has no configured models. Add an \`autoRouter\` entry to ~/.pi/agent/settings.json — falling back to ${anyModel.provider}/${anyModel.id} for now.`,
          "warning",
        );
      }
      return { model: anyModel, tier };
    }
    return undefined;
  }

  async function applyRouting(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    model: Model<Api>,
    tier: AutoRouterEffortLevel,
  ): Promise<void> {
    routingInFlight = true;
    try {
      const success = await pi.setModel(model);
      if (!success) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Auto: no credentials configured for ${model.provider}/${model.id}`,
            "warning",
          );
        }
        return;
      }
      await pi.setThinkingLevel(tier);
    } finally {
      routingInFlight = false;
    }
    lastKnownTier = tier;
    publishFooter(tier);
  }

  async function routeForPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    hasImages: boolean,
  ): Promise<void> {
    const settings = await readAutoRouterSettings();
    const classifierPool = resolveAvailableModels(
      ctx.modelRegistry,
      settings.efforts.medium?.models ?? allConfiguredModels(settings),
    );
    const classifierRef = healthStore.pickHealthy(classifierPool);
    const classifierModel = classifierRef
      ? classifierPool.find(
          (m) =>
            m.id === classifierRef.id && m.provider === classifierRef.provider,
        )
      : undefined;

    let level: AutoRouterEffortLevel = "medium";
    let classifierReply = "(no classifier available)";
    if (classifierModel) {
      const result = await classifyTurnComplexity(
        ctx.modelRegistry,
        classifierModel,
        prompt,
        hasImages,
      );
      level = result.level;
      classifierReply = result.reply;
      if (result.usage) {
        healthStore.recordSuccess(modelKey(classifierModel), result.usage);
      }
    }

    const tier = resolveEffortTier(settings, level);
    const picked = pickForTier(ctx, settings, tier);
    if (!picked) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Auto has no configured models yet. Add an `autoRouter` entry to ~/.pi/agent/settings.json.",
          "warning",
        );
      }
      return;
    }
    // Persisted so `/usage` can show what the classifier actually said - the classify call
    // itself is otherwise a throwaway completion whose result is discarded after parsing, which
    // made a prior misrouting report impossible to actually verify against real evidence.
    healthStore.recordClassification({
      prompt,
      reply: classifierReply,
      level,
      tier: picked.tier,
      model: picked.model,
    });
    await applyRouting(pi, ctx, picked.model, picked.tier);
  }

  async function reconcileAllProviders(
    modelRegistry: ModelRegistry,
    settings: AutoRouterSettings,
  ): Promise<void> {
    const models = allConfiguredModels(settings);
    const providers = Array.from(
      new Set(models.map((model) => model.provider)),
    );
    await Promise.all(
      providers.map(async (provider) => {
        const result = await reconcileProviderQuota(provider, modelRegistry);
        if (!result) return;
        for (const model of models) {
          if (model.provider !== provider) continue;
          const specific = result.perModel?.[normalizeModelId(model.id)];
          healthStore.applyQuotaResult(modelKey(model), specific ?? result.default);
        }
      }),
    );
  }

  pi.on("model_select", (event, _ctx) => {
    if (routingInFlight) return;
    if (event.model.provider === AUTO_PROVIDER_ID) {
      autoActive = true;
      pi.appendEntry(AUTO_ACTIVE_ENTRY_TYPE, { enabled: true });
      publishFooter(lastKnownTier);
      return;
    }
    if (event.source !== "restore" && autoActive) {
      autoActive = false;
      pi.appendEntry(AUTO_ACTIVE_ENTRY_TYPE, { enabled: false });
      lastKnownTier = undefined;
      clearFooter();
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    routingInFlight = false;
    lastKnownTier = undefined;
    // Reuse the single instance rather than replacing it: a stale instance's pending
    // debounced-save timer would otherwise still fire independently and could overwrite
    // this reload's freshly-loaded state on disk with the old in-memory data.
    await healthStore.load();
    // A session can arrive with Auto active two different ways: a persisted entry from an
    // earlier explicit `/model` pick (`restoreAutoActive`), or `ctx.model` already being the
    // placeholder because the user set `defaultProvider`/`defaultModel` to "auto" globally - a
    // brand-new session in that case has no entries yet, so `restoreAutoActive` alone would
    // miss it and leave every turn dispatching straight at the placeholder's dead URL.
    autoActive = restoreAutoActive(ctx) || ctx.model?.provider === AUTO_PROVIDER_ID;
    if (autoActive) {
      if (ctx.model && ctx.model.provider !== AUTO_PROVIDER_ID) {
        // Restored mid-turn (e.g. an interrupted process, before agent_settled could
        // revert it). Normalize back to the placeholder so /model shows Auto again.
        lastKnownTier = ctx.thinkingLevel;
        await revertToAutoPlaceholder(pi, ctx);
      }
      publishFooter(lastKnownTier);
    }
    const settings = await readAutoRouterSettings();
    void reconcileAllProviders(ctx.modelRegistry, settings);
    void ensureAutoModelScopedInGlobalSettings().catch(() => undefined);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!autoActive) return;
    if (!ctx.model || ctx.model.provider === AUTO_PROVIDER_ID) return;
    await revertToAutoPlaceholder(pi, ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!autoActive) return;
    await routeForPrompt(pi, ctx, event.prompt, Boolean(event.images?.length));
  });

  // Health/usage tracking isn't limited to turns Auto itself routed: any turn against a model
  // that's *configured* somewhere in autoRouter (picked manually from /model, or left over from
  // before Auto was engaged) is just as real a signal for future routing decisions and /usage,
  // so it's tracked the same way regardless of who selected the model.
  async function trackedModel(model: ModelIdentity | undefined): Promise<ModelIdentity | undefined> {
    if (!model || model.provider === AUTO_PROVIDER_ID) return undefined;
    const settings = await readAutoRouterSettings();
    const configured = allConfiguredModels(settings).some(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
    return configured ? model : undefined;
  }

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status >= 200 && event.status < 300) return;
    const model = await trackedModel(ctx.model);
    if (!model) return;
    healthStore.recordFailure(modelKey(model), event.status, event.headers);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    if (message.stopReason === "aborted") return; // user-cancelled, not a provider health signal
    const model = await trackedModel(ctx.model);
    if (!model) return;
    if (message.stopReason === "error") {
      healthStore.recordFailure(modelKey(model), inferFailureStatus(message.errorMessage), undefined);
      return;
    }
    const usage = isRecord(message) ? message.usage : undefined;
    healthStore.recordSuccess(modelKey(model), {
      input: numeric(isRecord(usage) ? usage.input : undefined),
      output: numeric(isRecord(usage) ? usage.output : undefined),
      cost: numeric(
        isRecord(usage) && isRecord(usage.cost) ? usage.cost.total : undefined,
      ),
    });
  });

  pi.on("session_shutdown", () => {
    void healthStore.flush();
    currentSessionId = undefined;
    autoActive = false;
  });

  pi.registerCommand("usage", {
    description: "Show Auto router health/usage for every configured model",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const settings = await readAutoRouterSettings();
      if (Object.keys(settings.efforts).length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Auto has no configured models. Add an `autoRouter` entry to ~/.pi/agent/settings.json.",
            "info",
          );
        }
        return;
      }
      await reconcileAllProviders(ctx.modelRegistry, settings);
      const rows = buildUsageRows(settings, healthStore);
      const classifications = healthStore.getClassifications();
      if (ctx.mode === "tui") {
        await showUsageDashboard(rows, classifications, ctx);
      } else if (ctx.hasUI) {
        ctx.ui.notify(formatUsagePlainText(rows, classifications), "info");
      }
    },
  });
}

type UsageRow = {
  tier: AutoRouterEffortLevel;
  model: AutoRouterModelRef;
  entry: ModelHealthEntry | undefined;
};

function buildUsageRows(
  settings: AutoRouterSettings,
  healthStore: AutoRouterHealthStore,
): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const tier of AUTO_ROUTER_EFFORT_ORDER) {
    for (const model of settings.efforts[tier]?.models ?? []) {
      rows.push({ tier, model, entry: healthStore.getEntry(modelKey(model)) });
    }
  }
  return rows;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `4557m` is meaningless at a glance; scale to hours/days once a cooldown is that long. */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function rowStatus(entry: ModelHealthEntry | undefined, now: number): string {
  if (!entry) return "unused";
  if (entry.cooldownUntil && entry.cooldownUntil > now) {
    const cause = entry.lastError ? ` (${entry.lastError.status})` : "";
    return `cooldown${cause} ~${formatDuration(entry.cooldownUntil - now)}`;
  }
  return "healthy";
}

/** Real usage from the provider's own quota API, when reconciliation has run for this model — separate from (and often more accurate than) this router's own request/token counters, which only see traffic this Pi installation itself made against the model. */
function verifiedUsageText(entry: ModelHealthEntry | undefined): string {
  if (!entry?.verifiedAt) return "—";
  return entry.verifiedDetail ?? "verified, no detail";
}

function rowLine(row: UsageRow, now: number): string {
  const entry = row.entry;
  const status = rowStatus(entry, now);
  const requests = entry?.totals.requests ?? 0;
  const tokens = formatTokenCount(
    (entry?.totals.input ?? 0) + (entry?.totals.output ?? 0),
  );
  return `${row.model.provider}/${row.model.id} — ${status} · ${verifiedUsageText(entry)} · ${requests} req · ${tokens} tok`;
}

/** How many recent classification decisions `/usage` shows, most recent first. */
const CLASSIFICATION_DISPLAY_LIMIT = 5;

function formatRelativeTime(at: number, now: number): string {
  const delta = now - at;
  return delta < 60_000 ? "just now" : `${formatDuration(delta)} ago`;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function recentClassifications(
  entries: readonly ClassificationLogEntry[],
): ClassificationLogEntry[] {
  return entries.slice(-CLASSIFICATION_DISPLAY_LIMIT).reverse();
}

function formatUsagePlainText(
  rows: UsageRow[],
  classifications: readonly ClassificationLogEntry[],
): string {
  if (rows.length === 0) return "Auto: no models configured.";
  const now = Date.now();
  const byTier = new Map<AutoRouterEffortLevel, UsageRow[]>();
  for (const row of rows) {
    const list = byTier.get(row.tier) ?? [];
    list.push(row);
    byTier.set(row.tier, list);
  }
  const lines: string[] = [];
  for (const [tier, tierRows] of byTier) {
    lines.push(
      `${tier}: ${tierRows.map((row) => rowLine(row, now)).join(" | ")}`,
    );
  }
  const recent = recentClassifications(classifications);
  if (recent.length > 0) {
    lines.push("", "Recent classifications:");
    for (const entry of recent) {
      lines.push(
        `  ${formatRelativeTime(entry.timestamp, now)}: said "${entry.reply}" → ${entry.level}, routed to ${entry.tier} (${entry.model.provider}/${entry.model.id})`,
      );
    }
  }
  return lines.join("\n");
}

function formatUsageMarkdown(
  rows: UsageRow[],
  classifications: readonly ClassificationLogEntry[],
): string {
  if (rows.length === 0) return "No models configured.";
  const now = Date.now();
  const lines = [
    "| Tier | Model | Status | Verified usage | Observed req | Observed tokens | Observed cost |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const entry = row.entry;
    const cost = entry ? `$${entry.totals.cost.toFixed(3)}` : "$0.000";
    const tokens = formatTokenCount(
      (entry?.totals.input ?? 0) + (entry?.totals.output ?? 0),
    );
    lines.push(
      `| ${row.tier} | ${row.model.provider}/${row.model.id} | ${rowStatus(entry, now)} | ${verifiedUsageText(entry)} | ${entry?.totals.requests ?? 0} | ${tokens} | ${cost} |`,
    );
  }
  lines.push(
    "",
    "_Verified usage comes from the provider's own quota API, where available. Observed req/tokens/cost count every turn this Pi installation has run against that model since Auto started tracking it — whether Auto routed there or it was picked manually from `/model` — but not usage from other sessions/machines/tools or from before that; that's exactly what verified usage is for._",
  );
  const recent = recentClassifications(classifications);
  if (recent.length > 0) {
    lines.push(
      "",
      "### Recent classifications",
      "_What the classifier actually said, so a routing decision that looks wrong can be checked against real evidence instead of guessed at._",
      "",
      "| When | Said | Level | Tier used | Model |",
      "|---|---|---|---|---|",
    );
    for (const entry of recent) {
      lines.push(
        `| ${formatRelativeTime(entry.timestamp, now)} | ${escapeTableCell(entry.reply)} | ${entry.level} | ${entry.tier} | ${entry.model.provider}/${entry.model.id} |`,
      );
    }
  }
  return lines.join("\n");
}

async function showUsageDashboard(
  rows: UsageRow[],
  classifications: readonly ClassificationLogEntry[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Auto Router Usage")), 1, 0),
    );
    container.addChild(
      new Markdown(formatUsageMarkdown(rows, classifications), 1, 1, mdTheme),
    );
    container.addChild(
      new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
    );
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape"))
          done(undefined);
      },
    };
  });
}
