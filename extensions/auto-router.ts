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
  truncateForLog,
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
const PINNED_MODEL_PREFIX = `${AUTO_MODEL_ID}-`;

/** Model id for the `/model` entry that pins Auto to `tier` instead of classifying each turn. */
function pinnedModelId(tier: AutoRouterEffortLevel): string {
  return `${PINNED_MODEL_PREFIX}${tier}`;
}

/** The reverse of `pinnedModelId`: which tier (if any) a selected auto-provider model id pins to. `undefined` for the plain adaptive "auto" id. */
function tierFromModelId(id: string): AutoRouterEffortLevel | undefined {
  if (!id.startsWith(PINNED_MODEL_PREFIX)) return undefined;
  const candidate = id.slice(PINNED_MODEL_PREFIX.length);
  return (AUTO_ROUTER_EFFORT_ORDER as readonly string[]).includes(candidate)
    ? (candidate as AutoRouterEffortLevel)
    : undefined;
}

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

type AutoState = { active: boolean; pinnedTier: AutoRouterEffortLevel | undefined };

function restoreAutoState(ctx: ExtensionContext): AutoState {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === AUTO_ACTIVE_ENTRY_TYPE
    ) {
      const data = entry.data;
      if (!isRecord(data) || data.enabled !== true) {
        return { active: false, pinnedTier: undefined };
      }
      const pinnedTier =
        typeof data.pinnedTier === "string" &&
        (AUTO_ROUTER_EFFORT_ORDER as readonly string[]).includes(data.pinnedTier)
          ? (data.pinnedTier as AutoRouterEffortLevel)
          : undefined;
      return { active: true, pinnedTier };
    }
  }
  return { active: false, pinnedTier: undefined };
}

function formatTier(tier: AutoRouterEffortLevel): string {
  return tier;
}

/**
 * The footer badge always reflects the current `/model` selection - "Auto (auto)" for the
 * plain adaptive entry, "Auto (<tier>)" for a pinned one - never what a given turn happened to
 * classify or dispatch to. Showing per-turn routing here made the badge look like a claim about
 * the model in use (e.g. "Auto (max)" beside a model actually running at a lower thinking level,
 * whenever that model's own `effort` override differs from its tier), when the selection never
 * changed. `/usage` is the place to see what actually got routed to.
 */
function footerBadge(pinnedTier: AutoRouterEffortLevel | undefined): string {
  return `🔀 Auto (${pinnedTier ?? "auto"})`;
}

/** A registered-but-inert `/model` entry: never actually dispatched to, since `before_agent_start` always swaps in a real routed model first. */
function placeholderModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

export default async function autoRouter(pi: ExtensionAPI): Promise<void> {
  // Read once at startup (not re-read later) to decide which per-tier "Auto (<tier>)" picker
  // entries to register - config changes after this need a process restart to pick up new
  // tiers, same as any other extension code change.
  const initialSettings = await readAutoRouterSettings();
  const pinnedTierModels = AUTO_ROUTER_EFFORT_ORDER.filter(
    (tier) => (initialSettings.efforts[tier]?.models.length ?? 0) > 0,
  ).map((tier) => placeholderModel(pinnedModelId(tier), `Auto (${tier})`));

  pi.registerProvider(AUTO_PROVIDER_ID, {
    name: "Auto",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "auto-router",
    api: "openai-completions",
    models: [
      placeholderModel(AUTO_MODEL_ID, "Auto (auto)"),
      ...pinnedTierModels,
    ],
  });

  let currentSessionId: string | undefined;
  let autoActive = false;
  /** Set when the user picked a specific "Auto (<tier>)" entry rather than plain "Auto":
   * every turn routes within that tier directly, skipping classification entirely. */
  let pinnedTier: AutoRouterEffortLevel | undefined;
  let routingInFlight = false;
  const healthStore = new AutoRouterHealthStore();

  function publishFooter(): void {
    if (!currentSessionId) return;
    pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
      sessionId: currentSessionId,
      key: FOOTER_KEY,
      identitySuffix: (theme: Theme) => theme.fg("accent", footerBadge(pinnedTier)),
    } satisfies FooterContribution);
  }

  /** The specific auto-provider `/model` id currently selected: the pinned tier's, or the plain adaptive one. */
  function currentAutoModelId(): string {
    return pinnedTier ? pinnedModelId(pinnedTier) : AUTO_MODEL_ID;
  }

  /** Swap `ctx.model` back to the inert Auto placeholder (whichever one is selected - adaptive or a pinned tier) once a turn is fully done, so `/model` keeps showing it selected instead of whichever real model just handled the turn. */
  async function revertToAutoPlaceholder(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
  ): Promise<void> {
    const placeholder = ctx.modelRegistry.find(
      AUTO_PROVIDER_ID,
      currentAutoModelId(),
    );
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

  /**
   * The thinking level to actually dispatch a model at: its own configured `effort` override,
   * or the tier name itself when it doesn't have one. `refs` is whichever tier's config list
   * `model` was resolved from, so the matching entry (and its override, if any) can be found.
   */
  function resolveEffort(
    refs: AutoRouterModelRef[],
    model: ModelIdentity,
    tier: AutoRouterEffortLevel,
  ): AutoRouterEffortLevel {
    const ref = refs.find(
      (candidate) =>
        candidate.provider === model.provider && candidate.id === model.id,
    );
    return ref?.effort ?? tier;
  }

  /** Pick the best available (resolved + healthy) model for `tier`, escalating to higher configured tiers when everything in `tier` is unhealthy, then falling back to the first available model anywhere as a last resort. */
  function pickForTier(
    ctx: ExtensionContext,
    settings: AutoRouterSettings,
    tier: AutoRouterEffortLevel,
  ):
    | { model: Model<Api>; tier: AutoRouterEffortLevel; effort: AutoRouterEffortLevel }
    | undefined {
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
        if (model) {
          return {
            model,
            tier: candidateTier,
            effort: resolveEffort(refs, model, candidateTier),
          };
        }
      }
    }
    // Last resort: nothing healthy anywhere. Use the first resolvable model still configured
    // for `tier` itself, or failing that the first resolvable model in any other configured
    // tier - labeled with whichever tier the picked model actually belongs to, not blindly
    // `tier`, since mislabeling it would apply the wrong thinking level to the model in use.
    const ownRefs = settings.efforts[tier]?.models;
    let fallback = ownRefs
      ? resolveAvailableModels(ctx.modelRegistry, ownRefs)[0]
      : undefined;
    let fallbackTier = tier;
    let fallbackRefs = ownRefs ?? [];
    if (!fallback) {
      for (const candidateTier of AUTO_ROUTER_EFFORT_ORDER) {
        const refs = settings.efforts[candidateTier]?.models;
        if (!refs) continue;
        const candidate = resolveAvailableModels(ctx.modelRegistry, refs)[0];
        if (candidate) {
          fallback = candidate;
          fallbackTier = candidateTier;
          fallbackRefs = refs;
          break;
        }
      }
    }
    if (fallback) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto: every configured ${formatTier(tier)} model looks unavailable; using ${fallback.provider}/${fallback.id} anyway. Check /usage.`,
          "warning",
        );
      }
      return {
        model: fallback,
        tier: fallbackTier,
        effort: resolveEffort(fallbackRefs, fallback, fallbackTier),
      };
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
      return { model: anyModel, tier, effort: tier };
    }
    return undefined;
  }

  async function applyRouting(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    model: Model<Api>,
    effort: AutoRouterEffortLevel,
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
      await pi.setThinkingLevel(effort);
    } finally {
      routingInFlight = false;
    }
  }

  async function routeForPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    prompt: string,
    hasImages: boolean,
  ): Promise<void> {
    const settings = await readAutoRouterSettings();

    let tier: AutoRouterEffortLevel;
    let level: string;
    let classifierReply: string;
    if (pinnedTier) {
      // The user picked "Auto (<tier>)" specifically to skip classification and always route
      // within that tier - pickForTier's own escalation/fallback still applies if it's unhealthy.
      tier = pinnedTier;
      level = "(pinned)";
      classifierReply = `pinned to ${pinnedTier} - not classified`;
    } else {
      const classifierRefs = settings.efforts.medium?.models ?? allConfiguredModels(settings);
      const classifierPool = resolveAvailableModels(ctx.modelRegistry, classifierRefs);
      const classifierRef = healthStore.pickHealthy(classifierPool);
      const classifierModel = classifierRef
        ? classifierPool.find(
            (m) =>
              m.id === classifierRef.id && m.provider === classifierRef.provider,
          )
        : undefined;

      let classifiedLevel: AutoRouterEffortLevel = "medium";
      classifierReply = "(no classifier available)";
      if (classifierModel) {
        // Same effort this model would actually be dispatched at for real work in the medium
        // tier - its own configured override, or "medium" itself - so the classify call reasons
        // at the level the user configured for it rather than an unrelated provider default.
        const classifierEffort = resolveEffort(classifierRefs, classifierModel, "medium");
        const result = await classifyTurnComplexity(
          ctx.modelRegistry,
          classifierModel,
          prompt,
          hasImages,
          classifierEffort,
        );
        classifiedLevel = result.level;
        classifierReply = result.reply;
        if (result.usage) {
          healthStore.recordSuccess(modelKey(classifierModel), result.usage);
        }
        // The classifier defaulting to `medium` isn't a real judgment of this turn's complexity
        // when it failed to answer at all - that's silently indistinguishable from a genuine
        // medium verdict otherwise, which is exactly what let a sustained classifier failure go
        // unnoticed. Surface it visibly rather than let it pass as ordinary routing.
        if (result.failed && ctx.hasUI) {
          // A failed reply can now run up to CLASSIFY_MAX_TOKENS long (e.g. a reasoning model
          // that never got to its answer) - bound it here the same way it's already bounded for
          // /usage below, so one long reply can't flood this notification and bury the warning.
          ctx.ui.notify(
            `Auto: classifier gave no usable answer (${truncateForLog(result.reply, 500)}); defaulting to ${classifiedLevel} for this turn. Check /usage for details.`,
            "warning",
          );
        }
      }
      level = classifiedLevel;
      tier = resolveEffortTier(settings, classifiedLevel);
    }

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
      reply: classifierReply,
      level,
      tier: picked.tier,
      effort: picked.effort,
      model: picked.model,
    });
    await applyRouting(pi, ctx, picked.model, picked.effort);
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
      pinnedTier = tierFromModelId(event.model.id);
      pi.appendEntry(AUTO_ACTIVE_ENTRY_TYPE, { enabled: true, pinnedTier });
      // Reflects the selection itself, immediately - "Auto (auto)" or "Auto (<tier>)" - not
      // anything about routing, so there's nothing to wait for a turn to determine.
      publishFooter();
      return;
    }
    if (event.source !== "restore" && autoActive) {
      autoActive = false;
      pinnedTier = undefined;
      pi.appendEntry(AUTO_ACTIVE_ENTRY_TYPE, { enabled: false });
      clearFooter();
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    routingInFlight = false;
    // Reuse the single instance rather than replacing it: a stale instance's pending
    // debounced-save timer would otherwise still fire independently and could overwrite
    // this reload's freshly-loaded state on disk with the old in-memory data.
    await healthStore.load();
    // A session can arrive with Auto active two different ways: a persisted entry from an
    // earlier explicit `/model` pick (`restoreAutoState`), or `ctx.model` already being one of
    // Auto's placeholders because the user set `defaultProvider`/`defaultModel` to "auto" (or a
    // pinned "auto-<tier>" id) globally - a brand-new session in that case has no entries yet,
    // so `restoreAutoState` alone would miss it and leave every turn dispatching straight at
    // the placeholder's dead URL.
    const restored = restoreAutoState(ctx);
    const modelIsAuto = ctx.model?.provider === AUTO_PROVIDER_ID;
    autoActive = restored.active || modelIsAuto;
    pinnedTier =
      restored.pinnedTier ??
      (modelIsAuto && ctx.model ? tierFromModelId(ctx.model.id) : undefined);
    if (autoActive) {
      if (ctx.model && ctx.model.provider !== AUTO_PROVIDER_ID) {
        // Restored mid-turn (e.g. an interrupted process, before agent_settled could
        // revert it). Normalize back to the placeholder so /model shows Auto again.
        await revertToAutoPlaceholder(pi, ctx);
      }
      publishFooter();
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
    if (!autoActive) {
      // `autoActive` is bookkeeping derived from model_select/session_start events, and every
      // path that's supposed to keep it in sync with reality is a separate thing to get right -
      // exactly the kind of thing that's easy to miss one case of (as happened with a brand-new
      // session whose defaultModel is "auto" in settings). But whether a request is about to be
      // sent against the inert placeholder is directly observable right here, right before
      // dispatch: if `ctx.model` already *is* one of Auto's placeholders, sending this turn as-is
      // is guaranteed to fail with a bare connection error no matter why our own flag says
      // inactive. So treat that as authoritative and self-heal instead of trusting the flag.
      if (ctx.model?.provider !== AUTO_PROVIDER_ID) return;
      autoActive = true;
      pinnedTier = tierFromModelId(ctx.model.id);
      pi.appendEntry(AUTO_ACTIVE_ENTRY_TYPE, { enabled: true, pinnedTier });
      publishFooter();
    }
    await routeForPrompt(pi, ctx, event.prompt, Boolean(event.images?.length));
  });

  // Health/usage tracking isn't limited to turns Auto itself routed: any turn against a model
  // that's *configured* somewhere in autoRouter (picked manually from /model, or left over from
  // before Auto was engaged) is just as real a signal for future routing decisions and /usage,
  // so it's tracked the same way regardless of who selected the model.
  const TRACKED_SETTINGS_CACHE_MS = 5_000;
  let trackedSettingsCache: { settings: AutoRouterSettings; expiresAt: number } | undefined;

  // Short-TTL cache scoped to this membership check specifically: after_provider_response and
  // message_end can both fire multiple times per turn, and re-reading + re-parsing settings.json
  // from disk for each one is wasted work when nothing's changed. Routing decisions themselves
  // (routeForPrompt, /usage, reconciliation) still always read fresh, since staleness there would
  // mean routing on config the user no longer has - a few seconds of staleness in "is this model
  // even one we track" is a much cheaper trade.
  async function trackedSettings(): Promise<AutoRouterSettings> {
    const now = Date.now();
    if (trackedSettingsCache && trackedSettingsCache.expiresAt > now) {
      return trackedSettingsCache.settings;
    }
    const settings = await readAutoRouterSettings();
    trackedSettingsCache = { settings, expiresAt: now + TRACKED_SETTINGS_CACHE_MS };
    return settings;
  }

  async function trackedModel(model: ModelIdentity | undefined): Promise<ModelIdentity | undefined> {
    if (!model || model.provider === AUTO_PROVIDER_ID) return undefined;
    const settings = await trackedSettings();
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
    // Best-effort telemetry: a transient write failure must not become an unhandled rejection.
    void healthStore.flush().catch(() => undefined);
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

/**
 * Neutralizes both pipes and line breaks for a Markdown table cell. Every current caller
 * already gets pre-collapsed text from `truncateForLog`, but this stays a defense of its own
 * rather than relying on that - a raw multi-line value would otherwise terminate the row early
 * and break the rest of the table, not just that one cell.
 */
export function escapeTableCell(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/\|/g, "\\|");
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
      const effortSuffix =
        entry.effort !== entry.tier ? ` at ${entry.effort} effort` : "";
      lines.push(
        `  ${formatRelativeTime(entry.timestamp, now)}: said "${entry.reply}" → ${entry.level}, routed to ${entry.tier}${effortSuffix} (${entry.model.provider}/${entry.model.id})`,
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
      "| When | Said | Level | Tier used | Effort applied | Model |",
      "|---|---|---|---|---|---|",
    );
    for (const entry of recent) {
      lines.push(
        `| ${formatRelativeTime(entry.timestamp, now)} | ${escapeTableCell(entry.reply)} | ${entry.level} | ${entry.tier} | ${entry.effort} | ${entry.model.provider}/${entry.model.id} |`,
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
