// SPDX-License-Identifier: MPL-2.0

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
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
import { readFile } from "node:fs/promises";
import {
	analyzeRepositoryDirection,
	analyzeRepositoryHistory,
	type AnalysisProgress,
	type RepositoryAuditResult,
} from "../src/analyze.ts";
import {
	inspectRepositoryGuidance,
	searchOpenGitHubThreads,
	submitGitHubIssue,
} from "../src/github-threads.ts";
import type {
	RepoInsightsResult,
	RepositoryAttribution,
	RepositoryIssueCandidate,
	RepositoryThreadLookup,
} from "../src/types.ts";
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
	let label = "Preparing issue proposal";
	if (progress.phase === "sessions") label = "Reading user prompts";
	if (progress.phase === "repositories")
		label = "Resolving and inventorying repositories";
	if (progress.phase === "classification")
		label = "Classifying requests and steering";
	if (progress.phase === "candidateAnalysis")
		label = "Identifying repository issue candidates";
	if (progress.phase === "audit")
		label = "Auditing open GitHub issues and pull requests";
	if (progress.phase === "proposal") label = "Preparing issue proposal";
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
		return (
			normalizedARank - normalizedBRank ||
			modelLabel(a).localeCompare(modelLabel(b))
		);
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
	throw new Error(
		`No authenticated ${role} model is available in the ${catalog} catalog`,
	);
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

function persistSettings(
	ctx: ExtensionCommandContext,
	settings: InsightsSettings,
): void {
	if (!saveInsightsSettings(settings)) {
		ctx.ui.notify(
			"Settings changed for this run but could not be saved",
			"warning",
		);
	}
}

async function showConfigurationPanel(
	ctx: ExtensionCommandContext,
	initial: InsightsSettings,
): Promise<InsightsSettings | undefined> {
	const settings = { ...initial };
	const result = await ctx.ui.custom<"done" | undefined>(
		(tui, theme, _keybindings, done) => {
			const modelSubmenu = (
				currentValue: string,
				close: (selectedValue?: string) => void,
			) => {
				const modelItems: SelectItem[] = availableModels(
					ctx,
					settings.modelCatalog,
				).map((model) => ({
					value: modelLabel(model),
					label: model.id,
					description: model.provider,
				}));
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
					description:
						"Chronological user prompts to consider before the global input cap",
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
					description:
						"Scoped follows Pi's scoped models; all shows every authenticated model",
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
					description:
						"Applies the repository-analysis skill; defaults to gpt-5.6-luna",
					currentValue: settings.analysisModel,
					submenu: modelSubmenu,
				},
				{
					id: "done",
					label: "Done",
					description: "Save these global settings and close the panel",
					currentValue: "Press Enter",
					values: ["done"],
				},
			];

			let list: SettingsList;
			list = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					if (id === "done") {
						done("done");
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
	if (result !== "done") return undefined;
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

type ModelContext = Parameters<
	ExtensionCommandContext["modelRegistry"]["complete"]
>[1];
type ModelTool = NonNullable<ModelContext["tools"]>[number];

// SAFETY: This literal follows pi-ai's Tool schema; the generic TSchema brand has no runtime fields.
const SEARCH_THREADS_TOOL = {
	name: "search_open_github_threads",
	description:
		"Search open GitHub issues and pull requests in the candidate repository using one concise semantic phrase.",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Semantic phrase likely to occur in a related thread",
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
} as unknown as ModelTool;

// SAFETY: This literal follows pi-ai's Tool schema; the generic TSchema brand has no runtime fields.
const INSPECT_GUIDANCE_TOOL = {
	name: "inspect_repository_guidance",
	description:
		"Read the repository's contribution guidelines and GitHub issue templates before drafting an issue.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
} as unknown as ModelTool;

function assistantText(
	response: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["complete"]>>,
): string {
	return response.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("");
}

async function callAuditModel(
	ctx: ExtensionCommandContext,
	model: ClassifierModel,
	prompt: string,
	candidate: RepositoryIssueCandidate,
	repository: RepositoryAttribution,
): Promise<RepositoryAuditResult> {
	const messages: ModelContext["messages"] = [
		{
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		},
	];
	const lookups: RepositoryThreadLookup[] = [];
	const guidance: RepositoryAuditResult["guidance"] = [];
	let guidanceResult: RepositoryAuditResult["guidance"][number] | undefined;
	let searchCalls = 0;
	for (let turn = 0; turn < 8; turn++) {
		const response = await ctx.modelRegistry.complete(model, {
			messages,
			tools: [SEARCH_THREADS_TOOL, INSPECT_GUIDANCE_TOOL],
		});
		messages.push(response);
		const toolCalls = response.content.filter(
			(content) => content.type === "toolCall",
		);
		if (toolCalls.length === 0) {
			return { response: assistantText(response), lookups, guidance };
		}
		for (const toolCall of toolCalls) {
			let result: RepositoryThreadLookup | RepositoryAuditResult["guidance"][number];
			if (toolCall.name === "search_open_github_threads") {
				searchCalls++;
				const query = String(toolCall.arguments.query ?? "").trim();
				result =
					searchCalls <= 4 && query
						? await searchOpenGitHubThreads(candidate.repository, query)
						: {
							repository: candidate.repository,
							status: "failed",
							threads: [],
							error: "Search query is empty or the audit exceeded four searches.",
						};
				lookups.push(result);
			} else if (toolCall.name === "inspect_repository_guidance") {
				guidanceResult ??= await inspectRepositoryGuidance(
					candidate.repository,
					repository.root,
				);
				result = guidanceResult;
				if (guidance.length === 0) guidance.push(guidanceResult);
			} else {
				result = {
					repository: candidate.repository,
					status: "failed",
					threads: [],
					error: `Unknown audit tool: ${toolCall.name}`,
				};
				lookups.push(result);
			}
			messages.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: JSON.stringify(result) }],
				isError: result.status !== "success",
				timestamp: Date.now(),
			});
		}
	}
	return {
		response: '{"decision":{"kind":"none"}}',
		lookups,
		guidance,
	};
}

async function presentProposals(
	ctx: ExtensionCommandContext,
	result: RepoInsightsResult,
): Promise<void> {
	if (result.contributions.length === 0) {
		const auditErrors = [
			...result.threadLookups.flatMap((lookup) =>
				lookup.status === "success" || !lookup.error ? [] : [lookup.error],
			),
			...result.guidanceResults.flatMap((guidance) =>
				guidance.status === "success" || !guidance.error ? [] : [guidance.error],
			),
		].slice(0, 3);
		const details = auditErrors.length
			? `\n\nAudit could not complete:\n- ${auditErrors.join("\n- ")}`
			: "";
		ctx.ui.notify(
			`No issue proposal was produced after auditing open issues and pull requests.${details}`,
			auditErrors.length ? "warning" : "info",
		);
		return;
	}
	for (const contribution of result.contributions) {
		if (contribution.kind === "existing") {
			if (contribution.existingThread) {
				const threadKind =
					contribution.existingThread.kind === "pull_request"
						? "pull request"
						: "issue";
				ctx.ui.notify(
					`Relevant open ${threadKind}: ${contribution.existingThread.url}\n\n${contribution.body}\n\nNo duplicate issue was proposed.`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`An existing contribution thread was identified for ${contribution.repository}, but its citation was unavailable. No issue was created.`,
					"warning",
				);
			}
			continue;
		}
		const labels = contribution.labels.length
			? `\n\nLabels\n${contribution.labels.join(", ")}`
			: "";
		const approved = await ctx.ui.confirm(
			`Create issue in ${contribution.repository}?`,
			`Title\n${contribution.title}${labels}\n\nBody\n${contribution.body}`,
		);
		if (!approved) continue;
		ctx.ui.setStatus("repo-insights", `Submitting issue to ${contribution.repository}…`);
		const submission = await submitGitHubIssue(
			contribution.repository,
			contribution.title,
			contribution.body,
			contribution.labels,
		);
		if (submission.status === "success") {
			ctx.ui.notify(`Issue created: ${submission.url}`, "info");
		} else {
			ctx.ui.notify(`Issue submission failed: ${submission.error}`, "error");
		}
	}
}

type ResolvedConfiguration = {
	settings: InsightsSettings;
	classifierModel: ClassifierModel;
	analysisModel: ClassifierModel;
};

function resolveConfiguration(
	ctx: ExtensionCommandContext,
): ResolvedConfiguration {
	const settings = loadInsightsSettings();
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
	if (
		modelLabel(classifierModel) !== settings.classifierModel ||
		modelLabel(analysisModel) !== settings.analysisModel
	) {
		settings.classifierModel = modelLabel(classifierModel);
		settings.analysisModel = modelLabel(analysisModel);
		persistSettings(ctx, settings);
	}
	return { settings, classifierModel, analysisModel };
}

export default function repoInsightsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("repo-insights-config", {
		description: "Configure repository insight models and history scope",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/repo-insights-config requires TUI mode", "warning");
				return;
			}
			try {
				const { settings } = resolveConfiguration(ctx);
				await showConfigurationPanel(ctx, settings);
			} catch (error) {
				ctx.ui.notify(
					`Repository insights configuration failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("repo-insights", {
		description:
			"Propose repository issues; pass an optional sentence to analyze that direction directly",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"/repo-insights requires TUI mode for issue approval",
					"warning",
				);
				return;
			}
			try {
				const direction = args.trim();
				const { settings, classifierModel, analysisModel } =
					resolveConfiguration(ctx);
				const repositoryAnalysisSkill = await loadPackagedSkill(
					ANALYZER_SKILL_URL,
					"repository analyzer",
				);
				const audit = (
					prompt: string,
					candidate: RepositoryIssueCandidate,
					repository: RepositoryAttribution,
				) =>
					callAuditModel(
						ctx,
						analysisModel,
						prompt,
						candidate,
						repository,
					);
				const onProgress = (progress: AnalysisProgress) => {
					ctx.ui.setWidget("repo-insights", progressLines(progress));
				};
				ctx.ui.setStatus(
					"repo-insights",
					direction ? "Analyzing requested direction…" : "Analyzing user steering…",
				);
				let result: RepoInsightsResult;
				if (direction) {
					ctx.ui.setWidget(
						"repo-insights",
						progressLines({ phase: "repositories", completed: 0, total: 2 }),
					);
					result = await analyzeRepositoryDirection(
						ctx.cwd,
						direction,
						async (prompt) => callModel(ctx, analysisModel, prompt),
						audit,
						repositoryAnalysisSkill,
						onProgress,
					);
				} else {
					ctx.ui.setWidget(
						"repo-insights",
						progressLines({ phase: "sessions", completed: 0, total: 1 }),
					);
					const classifierSkill = await loadPackagedSkill(
						CLASSIFIER_SKILL_URL,
						"classifier",
					);
					const sessionInfos = await SessionManager.listAll(
						(loadedCount, total) => {
							ctx.ui.setWidget(
								"repo-insights",
								progressLines({
									phase: "sessions",
									completed: loadedCount,
									total,
								}),
							);
						},
					);
					const sources = sessionInfos.map((info) => ({
						id: info.id,
						path: info.path,
						cwd: info.cwd,
						created: info.created,
						modified: info.modified,
					}));
					result = await analyzeRepositoryHistory(
						sources,
						async (source) => SessionManager.open(source.path).getEntries(),
						async (prompt) => callModel(ctx, classifierModel, prompt),
						async (prompt) => callModel(ctx, analysisModel, prompt),
						audit,
						classifierSkill,
						repositoryAnalysisSkill,
						{
							sinceDays: historyWindowDays(settings.historyWindow),
							maxSessions: settings.maxSessions,
							modelCatalog: settings.modelCatalog,
							classifierModel: modelLabel(classifierModel),
							analysisModel: modelLabel(analysisModel),
							currentSessionId: ctx.sessionManager.getSessionId(),
							onProgress,
						},
					);
				}
				await presentProposals(ctx, result);
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
