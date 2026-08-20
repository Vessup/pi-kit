import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelItem = {
  provider: string;
  id: string;
  model: unknown;
};

type SelectorInstance = {
  currentModel: unknown;
  scope: string;
  scopedModelItems: ModelItem[];
  activeModels: ModelItem[];
  filteredModels: ModelItem[];
  selectedIndex: number;
  sortModels: (models: ModelItem[]) => ModelItem[];
};

type SelectorPrototype = {
  sortModels?: (this: SelectorInstance, models: ModelItem[]) => ModelItem[];
  loadModelsFromSnapshot?: (this: SelectorInstance) => void;
  [PATCHED]: boolean | undefined;
};

const PATCHED = Symbol("pi-kit-model-order-patched");

function modelKey(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const value = model as { provider?: unknown; id?: unknown };
  return typeof value.provider === "string" && typeof value.id === "string"
    ? `${value.provider}/${value.id}`
    : undefined;
}

function orderModels(this: SelectorInstance, models: ModelItem[]): ModelItem[] {
  const currentKey = modelKey(this.currentModel);
  return [...models].sort((a, b) => {
    // Keep Auto Router together at the top, then keep every other provider
    // contiguous. The current model is only promoted within its provider.
    const aProvider = a.provider === "auto" ? "" : a.provider;
    const bProvider = b.provider === "auto" ? "" : b.provider;
    const providerOrder = aProvider.localeCompare(bProvider);
    if (providerOrder !== 0) return providerOrder;

    const aIsCurrent = currentKey === `${a.provider}/${a.id}`;
    const bIsCurrent = currentKey === `${b.provider}/${b.id}`;
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    return 0;
  });
}

async function installModelOrdering(): Promise<void> {
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const modulePath = new URL(
    "./modes/interactive/components/model-selector.js",
    packageEntry,
  ).href;
  const module = (await import(modulePath)) as unknown as {
    ModelSelectorComponent?: { prototype?: SelectorPrototype };
  };
  const prototype = module.ModelSelectorComponent?.prototype;
  if (!prototype || prototype[PATCHED]) return;

  const originalLoad = prototype.loadModelsFromSnapshot;
  if (!originalLoad) return;

  prototype[PATCHED] = true;
  prototype.sortModels = orderModels;
  prototype.loadModelsFromSnapshot = function (this: SelectorInstance): void {
    originalLoad.call(this);
    this.scopedModelItems = this.sortModels(this.scopedModelItems);
    if (this.scope !== "scoped") return;

    this.activeModels = this.scopedModelItems;
    this.filteredModels = this.activeModels;
    const currentIndex = this.filteredModels.findIndex(
      (item) => modelKey(this.currentModel) === `${item.provider}/${item.id}`,
    );
    this.selectedIndex =
      currentIndex >= 0
        ? currentIndex
        : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  };
}

export default function modelOrder(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      await installModelOrdering();
    } catch {
      // The selector is an internal TUI component and may move between Pi versions.
    }
  });
}
