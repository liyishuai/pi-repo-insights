// SPDX-License-Identifier: MPL-2.0

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	getSettingsListTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRepositoryHistory, type AnalysisProgress } from "../src/analyze.ts";
import { renderMarkdown } from "../src/report.ts";
import {
	HISTORY_WINDOWS,
	historyWindowDays,
	loadInsightsSettings,
	saveInsightsSettings,
	SESSION_LIMITS,
	type InsightsSettings,
} from "../src/settings.ts";

type ClassifierModel = NonNullable<ExtensionCommandContext["model"]>;

const CLASSIFIER_SKILL_URL = new URL(
	"../skills/repo-insights-classifier/SKILL.md",
	import.meta.url,
);

async function loadClassifierSkill(): Promise<string> {
	const skill = await readFile(CLASSIFIER_SKILL_URL, "utf8");
	if (!skill.trim()) throw new Error("The packaged classifier skill is empty");
	return skill;
}

function progressLines(progress: AnalysisProgress): string[] {
	let label = "Building report";
	if (progress.phase === "sessions") label = "Reading user prompts";
	if (progress.phase === "repositories") label = "Resolving repository attribution";
	if (progress.phase === "classification") label = "Classifying requests and steering";
	if (progress.phase === "themes") label = "Grouping steering themes";
	return [
		"",
		"  Pi Repository Insights",
		"  ─────────────────────────",
		`  ${label}: ${progress.completed}/${progress.total}`,
	];
}

function modelLabel(model: ClassifierModel): string {
	return `${model.provider}/${model.id}`;
}

function availableModels(ctx: ExtensionCommandContext): ClassifierModel[] {
	const preferredOrder = ["gpt-5.3-codex-spark", "gpt-5.6-luna"];
	return [...ctx.modelRegistry.getAvailable()].sort((a, b) => {
		const aRank = preferredOrder.indexOf(a.id);
		const bRank = preferredOrder.indexOf(b.id);
		const normalizedARank = aRank < 0 ? preferredOrder.length : aRank;
		const normalizedBRank = bRank < 0 ? preferredOrder.length : bRank;
		return normalizedARank - normalizedBRank || modelLabel(a).localeCompare(modelLabel(b));
	});
}

function defaultModel(
	ctx: ExtensionCommandContext,
	preferredId: string,
	role: string,
): ClassifierModel {
	const available = availableModels(ctx);
	const preferred =
		available.find(
			(model) => modelLabel(model) === `openai-codex/${preferredId}`,
		) ?? available.find((model) => model.id === preferredId);
	if (preferred) return preferred;
	if (ctx.model) return ctx.model;
	if (available[0]) return available[0];
	throw new Error(`No authenticated ${role} model is available`);
}

function defaultClassifierModel(ctx: ExtensionCommandContext): ClassifierModel {
	return defaultModel(ctx, "gpt-5.3-codex-spark", "classifier");
}

function defaultAnalysisModel(ctx: ExtensionCommandContext): ClassifierModel {
	return defaultModel(ctx, "gpt-5.6-luna", "analysis");
}

function resolveModel(
	ctx: ExtensionCommandContext,
	configured: string,
	fallback: () => ClassifierModel,
): ClassifierModel {
	return (
		availableModels(ctx).find(
			(model) => modelLabel(model) === configured || model.id === configured,
		) ?? fallback()
	);
}

function persistSettings(ctx: ExtensionCommandContext, settings: InsightsSettings): void {
	if (!saveInsightsSettings(settings)) {
		ctx.ui.notify("Settings changed for this run but could not be saved", "warning");
	}
}

async function showConfigurationPanel(
	ctx: ExtensionCommandContext,
	initial: InsightsSettings,
): Promise<InsightsSettings | undefined> {
	const settings = { ...initial };
	const modelItems: SelectItem[] = availableModels(ctx).map((model) => ({
		value: modelLabel(model),
		label: model.id,
		description: model.provider,
	}));

	const result = await ctx.ui.custom<"run" | undefined>(
		(tui, theme, _keybindings, done) => {
			const items: SettingItem[] = [
				{
					id: "historyWindow",
					label: "History window",
					description: "Chronological user prompts to consider before the global input cap",
					currentValue: settings.historyWindow,
					values: [...HISTORY_WINDOWS],
				},
				{
					id: "maxSessions",
					label: "Session limit",
					description: "Maximum recent sessions loaded before prompt classification",
					currentValue: String(settings.maxSessions),
					values: SESSION_LIMITS.map(String),
				},
				{
					id: "classifierModel",
					label: "Classifier model",
					description: "Classifies every prompt; defaults to gpt-5.3-codex-spark",
					currentValue: settings.classifierModel,
					submenu: (currentValue, close) => {
						const list = new SelectList(modelItems, Math.min(modelItems.length, 12), {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						});
						list.onSelect = (item) => close(item.value);
						list.onCancel = () => close();
						const configuredIndex = modelItems.findIndex(
							(item) => item.value === currentValue,
						);
						if (configuredIndex >= 0) list.setSelectedIndex(configuredIndex);
						return list;
					},
				},
				{
					id: "analysisModel",
					label: "Analysis model",
					description: "Groups validated steering paraphrases into themes; defaults to gpt-5.6-luna",
					currentValue: settings.analysisModel,
					submenu: (currentValue, close) => {
						const list = new SelectList(modelItems, Math.min(modelItems.length, 12), {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						});
						list.onSelect = (item) => close(item.value);
						list.onCancel = () => close();
						const configuredIndex = modelItems.findIndex(
							(item) => item.value === currentValue,
						);
						if (configuredIndex >= 0) list.setSelectedIndex(configuredIndex);
						return list;
					},
				},
				{
					id: "run",
					label: "Run analysis",
					description: "Classify prompts now and write report.md plus report.json",
					currentValue: "Press Enter",
					values: ["run"],
				},
			];

			const list = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					if (id === "run") {
						done("run");
						return;
					}
					if (id === "historyWindow") {
						settings.historyWindow = value as InsightsSettings["historyWindow"];
					} else if (id === "maxSessions") {
						settings.maxSessions = Number(value);
					} else if (id === "classifierModel") {
						settings.classifierModel = value;
					} else if (id === "analysisModel") {
						settings.analysisModel = value;
					}
					persistSettings(ctx, settings);
				},
				() => done(undefined),
			);
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Repository Insights")), 1, 0),
			);
			container.addChild(
				new Text(
					theme.fg("muted", "Prompt classification: Spark · Theme analysis: Luna"),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));
			container.addChild(list);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	if (result !== "run") return undefined;
	persistSettings(ctx, settings);
	return settings;
}

async function callModel(
	ctx: ExtensionCommandContext,
	model: ClassifierModel,
	prompt: string,
): Promise<string> {
	const response = await ctx.modelRegistry.complete(model, {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			},
		],
	});
	return response.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("");
}

export default function repoInsightsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("repo-insights", {
		description: "Configure and run user-prompt steering analysis",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/repo-insights opens an interactive panel and requires TUI mode", "warning");
				return;
			}
			try {
				const defaultClassifier = defaultClassifierModel(ctx);
				const defaultAnalysis = defaultAnalysisModel(ctx);
				const loaded = loadInsightsSettings(
					modelLabel(defaultClassifier),
					modelLabel(defaultAnalysis),
				);
				const configuredClassifier = resolveModel(
					ctx,
					loaded.classifierModel,
					() => defaultClassifier,
				);
				const configuredAnalysis = resolveModel(
					ctx,
					loaded.analysisModel,
					() => defaultAnalysis,
				);
				if (
					modelLabel(configuredClassifier) !== loaded.classifierModel ||
					modelLabel(configuredAnalysis) !== loaded.analysisModel
				) {
					loaded.classifierModel = modelLabel(configuredClassifier);
					loaded.analysisModel = modelLabel(configuredAnalysis);
					persistSettings(ctx, loaded);
				}
				const settings = await showConfigurationPanel(ctx, loaded);
				if (!settings) return;
				const classifierModel = resolveModel(
					ctx,
					settings.classifierModel,
					() => defaultClassifier,
				);
				const analysisModel = resolveModel(
					ctx,
					settings.analysisModel,
					() => defaultAnalysis,
				);
				const outputDirectory = join(getAgentDir(), "repo-insights");

				ctx.ui.setStatus("repo-insights", "Analyzing user steering…");
				ctx.ui.setWidget(
					"repo-insights",
					progressLines({ phase: "sessions", completed: 0, total: 1 }),
				);
				const classifierSkill = await loadClassifierSkill();
				const sessionInfos = await SessionManager.listAll((loadedCount, total) => {
					ctx.ui.setWidget(
						"repo-insights",
						progressLines({ phase: "sessions", completed: loadedCount, total }),
					);
				});
				const sources = sessionInfos.map((info) => ({
					id: info.id,
					path: info.path,
					cwd: info.cwd,
					created: info.created,
					modified: info.modified,
				}));
				const report = await analyzeRepositoryHistory(
					sources,
					async (source) => SessionManager.open(source.path).getEntries(),
					async (prompt) => callModel(ctx, classifierModel, prompt),
					async (prompt) => callModel(ctx, analysisModel, prompt),
					classifierSkill,
					{
						sinceDays: historyWindowDays(settings.historyWindow),
						maxSessions: settings.maxSessions,
						classifierModel: modelLabel(classifierModel),
						analysisModel: modelLabel(analysisModel),
						currentSessionId: ctx.sessionManager.getSessionId(),
						onProgress: (progress) => {
							ctx.ui.setWidget("repo-insights", progressLines(progress));
						},
					},
				);

				await mkdir(outputDirectory, { recursive: true });
				const markdownPath = join(outputDirectory, "report.md");
				const jsonPath = join(outputDirectory, "report.json");
				await Promise.all([
					writeFile(markdownPath, renderMarkdown(report), {
						encoding: "utf8",
						mode: 0o600,
					}),
					writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {
						encoding: "utf8",
						mode: 0o600,
					}),
				]);

				const steeringCount = report.classifications.filter(
					(classification) => classification.kind === "steering",
				).length;
				ctx.ui.notify(
					`Repository insights written:\n${markdownPath}\n${jsonPath}\n\n${report.sessions.promptsClassified} prompts classified; ${steeringCount} steering prompts`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Repository insights failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("repo-insights", undefined);
				ctx.ui.setWidget("repo-insights", undefined);
			}
		},
	});
}
