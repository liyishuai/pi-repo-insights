// SPDX-License-Identifier: MPL-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HISTORY_WINDOWS = ["all", "7d", "30d", "90d", "180d", "365d"] as const;
export const SESSION_LIMITS = [25, 50, 100, 200, 500, 1_000] as const;
export const MODEL_CATALOGS = ["scoped", "all"] as const;
export const DEFAULT_CLASSIFIER_MODEL = "openai-codex/gpt-5.3-codex-spark";
export const DEFAULT_ANALYSIS_MODEL = "openai-codex/gpt-5.6-luna";

export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];
export type ModelCatalog = (typeof MODEL_CATALOGS)[number];

export type InsightsSettings = {
	historyWindow: HistoryWindow;
	maxSessions: number;
	modelCatalog: ModelCatalog;
	classifierModel: string;
	analysisModel: string;
};

type StoredSettings = Partial<InsightsSettings>;

function configPath(): string {
	return join(getAgentDir(), "repo-insights", "config.json");
}

function defaults(): InsightsSettings {
	return {
		historyWindow: "all",
		maxSessions: 200,
		modelCatalog: "scoped",
		classifierModel: DEFAULT_CLASSIFIER_MODEL,
		analysisModel: DEFAULT_ANALYSIS_MODEL,
	};
}

function sanitize(value: StoredSettings | null): InsightsSettings {
	const fallback = defaults();
	const storedWindow = String(value?.historyWindow ?? "");
	const historyWindow = (HISTORY_WINDOWS as readonly string[]).includes(storedWindow)
		? (storedWindow as HistoryWindow)
		: fallback.historyWindow;
	const storedLimit = Number(value?.maxSessions);
	const maxSessions = (SESSION_LIMITS as readonly number[]).includes(storedLimit)
		? storedLimit
		: fallback.maxSessions;
	const storedCatalog = String(value?.modelCatalog ?? "");
	const modelCatalog = (MODEL_CATALOGS as readonly string[]).includes(storedCatalog)
		? (storedCatalog as ModelCatalog)
		: fallback.modelCatalog;
	const storedClassifier = String(value?.classifierModel ?? "").trim();
	const classifierModel =
		storedClassifier && storedClassifier.length <= 200
			? storedClassifier
			: fallback.classifierModel;
	const storedAnalysis = String(value?.analysisModel ?? "").trim();
	const analysisModel =
		storedAnalysis && storedAnalysis.length <= 200
			? storedAnalysis
			: fallback.analysisModel;
	return {
		historyWindow,
		maxSessions,
		modelCatalog,
		classifierModel,
		analysisModel,
	};
}

export function loadInsightsSettings(): InsightsSettings {
	const path = configPath();
	if (!existsSync(path)) return defaults();
	try {
		const stored = JSON.parse(readFileSync(path, "utf8")) as StoredSettings;
		return sanitize(stored);
	} catch {
		return defaults();
	}
}

export function saveInsightsSettings(settings: InsightsSettings): boolean {
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return true;
	} catch {
		return false;
	}
}

export function historyWindowDays(window: HistoryWindow): number {
	return window === "all" ? 0 : Number.parseInt(window, 10);
}
