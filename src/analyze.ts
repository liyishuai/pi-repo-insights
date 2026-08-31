// SPDX-License-Identifier: MPL-2.0

import {
	buildClassificationPlan,
	buildRepositoryAnalysisPrompt,
	parseClassificationBatch,
	parseRepositoryAnalysis,
} from "./skill-runtime.ts";
import { resolveRepositoryAttribution } from "./repository-attribution.ts";
import { analyzeSessionEntries } from "./session-analysis.ts";
import type {
	PromptClassification,
	RepoInsightsReport,
	ReportOptions,
	SessionEvidence,
	SessionSource,
	SteeringTheme,
} from "./types.ts";

export type AnalysisPhase =
	| "sessions"
	| "repositories"
	| "classification"
	| "themes"
	| "report";

export type AnalysisProgress = {
	phase: AnalysisPhase;
	completed: number;
	total: number;
};

export type AnalyzeOptions = ReportOptions & {
	currentSessionId?: string;
	now?: Date;
	concurrency?: number;
	onProgress?: (progress: AnalysisProgress) => void;
};

export type SessionLoader = (source: SessionSource) => Promise<unknown[]>;
export type SkillModelCall = (prompt: string) => Promise<string>;

function selectedSources(
	sources: SessionSource[],
	options: AnalyzeOptions,
): SessionSource[] {
	const now = (options.now ?? new Date()).getTime();
	const cutoff =
		options.sinceDays > 0
			? now - options.sinceDays * 24 * 60 * 60 * 1_000
			: Number.NEGATIVE_INFINITY;
	return sources
		.filter((source) => source.id !== options.currentSessionId)
		.filter((source) => source.modified.getTime() >= cutoff)
		.sort(
			(a, b) =>
				b.modified.getTime() - a.modified.getTime() || a.id.localeCompare(b.id),
		)
		.slice(0, options.maxSessions);
}

async function loadSessions(
	sources: SessionSource[],
	loadEntries: SessionLoader,
	options: AnalyzeOptions,
): Promise<SessionEvidence[]> {
	const sessions: SessionEvidence[] = [];
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32));
	let completed = 0;
	for (let index = 0; index < sources.length; index += concurrency) {
		const batch = sources.slice(index, index + concurrency);
		const results = await Promise.all(
			batch.map(async (source) => {
				try {
					return analyzeSessionEntries(await loadEntries(source), source);
				} catch {
					return undefined;
				} finally {
					completed++;
					options.onProgress?.({
						phase: "sessions",
						completed,
						total: sources.length,
					});
				}
			}),
		);
		for (const result of results) {
			if (result?.prompts.length) sessions.push(result);
		}
	}
	return sessions.sort(
		(a, b) =>
			b.modifiedAt.localeCompare(a.modifiedAt) ||
			a.sessionId.localeCompare(b.sessionId),
	);
}

async function classifyPrompts(
	plan: ReturnType<typeof buildClassificationPlan>,
	classify: SkillModelCall,
	onProgress: AnalyzeOptions["onProgress"],
): Promise<PromptClassification[]> {
	if (plan.batches.length === 0) return [];
	const results: PromptClassification[][] = [];
	let completed = 0;
	const concurrency = 4;
	for (let index = 0; index < plan.batches.length; index += concurrency) {
		const batch = plan.batches.slice(index, index + concurrency);
		const parsed = await Promise.all(
			batch.map(async (classificationBatch) => {
				const response = await classify(classificationBatch.prompt);
				const classifications = parseClassificationBatch(
					response,
					classificationBatch,
				);
				completed++;
				onProgress?.({
					phase: "classification",
					completed,
					total: plan.batches.length,
				});
				return classifications;
			}),
		);
		results.push(...parsed);
	}
	return results.flat();
}

export async function analyzeRepositoryHistory(
	sources: SessionSource[],
	loadEntries: SessionLoader,
	classify: SkillModelCall,
	analyzeRepositoryInsights: SkillModelCall,
	classifierSkill: string,
	repositoryAnalysisSkill: string,
	options: AnalyzeOptions,
): Promise<RepoInsightsReport> {
	const selected = selectedSources(sources, options);
	const sessions = await loadSessions(selected, loadEntries, options);
	options.onProgress?.({ phase: "repositories", completed: 0, total: 1 });
	const { repositories, repositoryKeysBySession } =
		await resolveRepositoryAttribution(sessions);
	options.onProgress?.({ phase: "repositories", completed: 1, total: 1 });

	const plan = buildClassificationPlan(
		sessions,
		repositoryKeysBySession,
		classifierSkill,
	);
	options.onProgress?.({
		phase: "classification",
		completed: 0,
		total: plan.batches.length,
	});
	const classifications = await classifyPrompts(
		plan,
		classify,
		options.onProgress,
	);
	const themeRequest = buildRepositoryAnalysisPrompt(
		classifications,
		repositoryAnalysisSkill,
	);
	let themes: SteeringTheme[] = [];
	if (themeRequest) {
		options.onProgress?.({ phase: "themes", completed: 0, total: 1 });
		themes = parseRepositoryAnalysis(
			await analyzeRepositoryInsights(themeRequest.prompt),
			themeRequest.refs,
		);
		options.onProgress?.({ phase: "themes", completed: 1, total: 1 });
	}
	options.onProgress?.({ phase: "report", completed: 1, total: 1 });
	const reportOptions: ReportOptions = {
		sinceDays: options.sinceDays,
		maxSessions: options.maxSessions,
	};
	if (options.modelCatalog) reportOptions.modelCatalog = options.modelCatalog;
	if (options.classifierModel) reportOptions.classifierModel = options.classifierModel;
	if (options.analysisModel) reportOptions.analysisModel = options.analysisModel;

	return {
		schemaVersion: 2,
		generatedAt: (options.now ?? new Date()).toISOString(),
		options: reportOptions,
		classifierModel: options.classifierModel ?? "active model",
		analysisModel: options.analysisModel ?? "active model",
		sessions: {
			discovered: sources.length,
			analyzed: sessions.length,
			skipped: sources.length - sessions.length,
			promptsAnalyzed: plan.promptCount,
			promptsClassified: classifications.length,
			promptCharactersSubmitted: plan.promptCharacters,
			promptInputTruncated: plan.truncated,
		},
		repositories,
		classifications,
		themes,
		methodology: [
			"The packaged repo-insights-classifier skill defines the request-versus-steering rubric.",
			"The packaged repo-insights-analyzer skill defines repository theme grouping and action synthesis.",
			"Chronological user prompts are classified as requests, steering, responses, or other content.",
			"A prompt that redirects current work and issues a new order is classified as steering; an initial desired outcome is classified as a request.",
			"The classifier model receives selected user prompts, and the analysis model receives validated steering paraphrases for theme grouping.",
			"Git roots, origin remotes, explicit GitHub references, and tool path arguments attribute classifications to repositories.",
			"Reports contain bounded model-generated paraphrases; host validation replaces any paraphrase that copies eight consecutive source words.",
			"Repository actions describe scripts, checks, CI contracts, schemas, or documented interfaces supported by grouped steering evidence.",
		],
	};
}
