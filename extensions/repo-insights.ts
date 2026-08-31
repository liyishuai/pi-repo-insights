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
	MODEL_CATALOGS,
	saveInsightsSettings,
	SESSION_LIMITS,
	type InsightsSettings,
	type ModelCatalog,
} from "../src/settings.ts";

type ClassifierModel = NonNullable<ExtensionCommandContext["model"]>;

const CLASSIFIER_SKILL_URL = new URL(
	"../skills/repo-insights-classifier/SKILL.md",
	import.meta.url,
);
const ANALYZER_SKILL_URL = new URL(
	"../skills/repo-insights-analyzer/SKILL.md",
	import.meta.url,
);

async function loadPackagedSkill(url: URL, name: string): Promise<string> {
	const skill = await readFile(url, "utf8");
	if (!skill.trim()) throw new Error(`The packaged ${name} skill is empty`);
	return skill;
}

function progressLines(progress: AnalysisProgress): string[] {
	let label = "Building report";
	if (progress.phase === "sessions") label = "Reading user prompts";
	if (progress.phase === "repositories") label = "Resolving repository attribution";
	if (progress.phase === "classification") label = "Classifying requests and steering";
	if (progress.phase === "themes") label = "Applying repository analysis skill";
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

function availableModels(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
): ClassifierModel[] {
	const all = [...ctx.modelRegistry.getAvailable()];
	const scopedLabels = new Set(
		ctx.scopedModels.map(({ model }) => modelLabel(model)),
	);
	const selected =
		catalog === "scoped" && scopedLabels.size > 0
			? all.filter((model) => scopedLabels.has(modelLabel(model)))
			: all;
	const preferredOrder = ["gpt-5.3-codex-spark", "gpt-5.6-luna"];
	return selected.sort((a, b) => {
		const aRank = preferredOrder.indexOf(a.id);
		const bRank = preferredOrder.indexOf(b.id);
		const normalizedARank = aRank < 0 ? preferredOrder.length : aRank;
		const normalizedBRank = bRank < 0 ? preferredOrder.length : bRank;
		return normalizedARank - normalizedBRank || modelLabel(a).localeCompare(modelLabel(b));
	});
}

function defaultModel(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
	preferredId: string,
	role: string,
): ClassifierModel {
	const available = availableModels(ctx, catalog);
	const preferred =
		available.find(
			(model) => modelLabel(model) === `openai-codex/${preferredId}`,
		) ?? available.find((model) => model.id === preferredId);
	if (preferred) return preferred;
	const currentModel = ctx.model;
	const active = currentModel
		? available.find((model) => modelLabel(model) === modelLabel(currentModel))
		: undefined;
	if (active) return active;
	if (available[0]) return available[0];
	throw new Error(`No authenticated ${role} model is available in the ${catalog} catalog`);
}

function defaultClassifierModel(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
): ClassifierModel {
	return defaultModel(ctx, catalog, "gpt-5.3-codex-spark", "classifier");
}

function defaultAnalysisModel(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
): ClassifierModel {
	return defaultModel(ctx, catalog, "gpt-5.6-luna", "analysis");
}

function resolveModel(
	ctx: ExtensionCommandContext,
	catalog: ModelCatalog,
	configured: string,
	fallback: () => ClassifierModel,
): ClassifierModel {
	return (
		availableModels(ctx, catalog).find(
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
	const result = await ctx.ui.custom<"run" | undefined>(
		(tui, theme, _keybindings, done) => {
			const modelSubmenu = (
				currentValue: string,
				close: (selectedValue?: string) => void,
			) => {
				const modelItems: SelectItem[] = availableModels(ctx, settings.modelCatalog).map(
					(model) => ({
						value: modelLabel(model),
						label: model.id,
						description: model.provider,
					}),
				);
				const modelList = new SelectList(
					modelItems,
					Math.min(modelItems.length, 12),
					{
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				);
				modelList.onSelect = (item) => close(item.value);
				modelList.onCancel = () => close();
				const configuredIndex = modelItems.findIndex(
					(item) => item.value === currentValue,
				);
				if (configuredIndex >= 0) modelList.setSelectedIndex(configuredIndex);
				return modelList;
			};

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
					id: "modelCatalog",
					label: "Model catalog",
					description: "Scoped follows Pi's scoped models; all shows every authenticated model",
					currentValue: settings.modelCatalog,
					values: [...MODEL_CATALOGS],
				},
				{
					id: "classifierModel",
					label: "Classifier model",
					description: "Classifies every prompt; defaults to gpt-5.3-codex-spark",
					currentValue: settings.classifierModel,
					submenu: modelSubmenu,
				},
				{
					id: "analysisModel",
					label: "Repository analysis model",
					description: "Applies the repository-analysis skill; defaults to gpt-5.6-luna",
					currentValue: settings.analysisModel,
					submenu: modelSubmenu,
				},
				{
					id: "run",
					label: "Run analysis",
					description: "Classify prompts now and write report.md plus report.json",
					currentValue: "Press Enter",
					values: ["run"],
				},
			];

			let list: SettingsList;
			list = new SettingsList(
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
					} else if (id === "modelCatalog") {
						settings.modelCatalog = value as ModelCatalog;
						const classifier = resolveModel(
							ctx,
							settings.modelCatalog,
							settings.classifierModel,
							() => defaultClassifierModel(ctx, settings.modelCatalog),
						);
						const analysis = resolveModel(
							ctx,
							settings.modelCatalog,
							settings.analysisModel,
							() => defaultAnalysisModel(ctx, settings.modelCatalog),
						);
						settings.classifierModel = modelLabel(classifier);
						settings.analysisModel = modelLabel(analysis);
						list.updateValue("classifierModel", settings.classifierModel);
						list.updateValue("analysisModel", settings.analysisModel);
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
					theme.fg("muted", "Portable classifier and repository-analysis skills"),
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
				const loaded = loadInsightsSettings();
				const defaultClassifier = defaultClassifierModel(ctx, loaded.modelCatalog);
				const defaultAnalysis = defaultAnalysisModel(ctx, loaded.modelCatalog);
				const configuredClassifier = resolveModel(
					ctx,
					loaded.modelCatalog,
					loaded.classifierModel,
					() => defaultClassifier,
				);
				const configuredAnalysis = resolveModel(
					ctx,
					loaded.modelCatalog,
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
					settings.modelCatalog,
					settings.classifierModel,
					() => defaultClassifierModel(ctx, settings.modelCatalog),
				);
				const analysisModel = resolveModel(
					ctx,
					settings.modelCatalog,
					settings.analysisModel,
					() => defaultAnalysisModel(ctx, settings.modelCatalog),
				);
				const outputDirectory = join(getAgentDir(), "repo-insights");

				ctx.ui.setStatus("repo-insights", "Analyzing user steering…");
				ctx.ui.setWidget(
					"repo-insights",
					progressLines({ phase: "sessions", completed: 0, total: 1 }),
				);
				const [classifierSkill, repositoryAnalysisSkill] = await Promise.all([
					loadPackagedSkill(CLASSIFIER_SKILL_URL, "classifier"),
					loadPackagedSkill(ANALYZER_SKILL_URL, "repository analyzer"),
				]);
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
					repositoryAnalysisSkill,
					{
						sinceDays: historyWindowDays(settings.historyWindow),
						maxSessions: settings.maxSessions,
						modelCatalog: settings.modelCatalog,
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
