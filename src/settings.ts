// SPDX-License-Identifier: MPL-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HISTORY_WINDOWS = ["all", "7d", "30d", "90d", "180d", "365d"] as const;
export const SESSION_LIMITS = [25, 50, 100, 200, 500, 1_000] as const;

export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

export type InsightsSettings = {
	historyWindow: HistoryWindow;
	maxSessions: number;
	classifierModel: string;
	analysisModel: string;
};

type StoredSettings = Partial<InsightsSettings>;

function configPath(): string {
	return join(getAgentDir(), "repo-insights", "config.json");
}

function defaults(
	defaultClassifierModel: string,
	defaultAnalysisModel: string,
): InsightsSettings {
	return {
		historyWindow: "all",
		maxSessions: 200,
		classifierModel: defaultClassifierModel,
		analysisModel: defaultAnalysisModel,
	};
}

function sanitize(
	value: StoredSettings | null,
	defaultClassifierModel: string,
	defaultAnalysisModel: string,
): InsightsSettings {
	const fallback = defaults(defaultClassifierModel, defaultAnalysisModel);
	const storedWindow = String(value?.historyWindow ?? "");
	const historyWindow = (HISTORY_WINDOWS as readonly string[]).includes(storedWindow)
		? (storedWindow as HistoryWindow)
		: fallback.historyWindow;
	const storedLimit = Number(value?.maxSessions);
	const maxSessions = (SESSION_LIMITS as readonly number[]).includes(storedLimit)
		? storedLimit
		: fallback.maxSessions;
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
	return { historyWindow, maxSessions, classifierModel, analysisModel };
}

export function loadInsightsSettings(
	defaultClassifierModel: string,
	defaultAnalysisModel: string,
): InsightsSettings {
	const path = configPath();
	if (!existsSync(path)) return defaults(defaultClassifierModel, defaultAnalysisModel);
	try {
		const stored = JSON.parse(readFileSync(path, "utf8")) as StoredSettings;
		return sanitize(stored, defaultClassifierModel, defaultAnalysisModel);
	} catch {
		return defaults(defaultClassifierModel, defaultAnalysisModel);
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
