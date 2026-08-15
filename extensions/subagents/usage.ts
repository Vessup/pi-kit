import type { FooterUsage } from "../footer-events.js";
import type { PersistedUsageState, Usage } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	const cost = value.cost;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	if (fields.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field]))) return undefined;
	const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	if (costFields.some((field) => typeof cost[field] !== "number" || !Number.isFinite(cost[field]))) return undefined;
	return {
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
		totalTokens: value.totalTokens as number,
		cost: {
			input: cost.input as number,
			output: cost.output as number,
			cacheRead: cost.cacheRead as number,
			cacheWrite: cost.cacheWrite as number,
			total: cost.total as number,
		},
	};
}

export function parsePersistedUsageState(value: unknown): PersistedUsageState | undefined {
	if (!isRecord(value)) return undefined;
	const total = parseUsage(value.total);
	const accounted = parseUsage(value.accounted);
	return total && accounted ? { total, accounted } : undefined;
}

export function cloneUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

export function addUsage(target: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input || 0;
	target.output += usage.output || 0;
	target.cacheRead += usage.cacheRead || 0;
	target.cacheWrite += usage.cacheWrite || 0;
	target.totalTokens += usage.totalTokens || 0;
	target.cost.input += usage.cost?.input || 0;
	target.cost.output += usage.cost?.output || 0;
	target.cost.cacheRead += usage.cost?.cacheRead || 0;
	target.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	target.cost.total += usage.cost?.total || 0;
}

export function subtractUsage(total: Usage, accounted: Usage): Usage {
	return {
		input: Math.max(0, total.input - accounted.input),
		output: Math.max(0, total.output - accounted.output),
		cacheRead: Math.max(0, total.cacheRead - accounted.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - accounted.cacheWrite),
		totalTokens: Math.max(0, total.totalTokens - accounted.totalTokens),
		cost: {
			input: Math.max(0, total.cost.input - accounted.cost.input),
			output: Math.max(0, total.cost.output - accounted.cost.output),
			cacheRead: Math.max(0, total.cost.cacheRead - accounted.cost.cacheRead),
			cacheWrite: Math.max(0, total.cost.cacheWrite - accounted.cost.cacheWrite),
			total: Math.max(0, total.cost.total - accounted.cost.total),
		},
	};
}

export function hasUsage(usage: Usage): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		usage.totalTokens > 0 ||
		usage.cost.total > 0
	);
}

export function asFooterUsage(usage: Usage): FooterUsage {
	return cloneUsage(usage);
}
