// SPDX-License-Identifier: MPL-2.0

import {
	buildClassificationPlan,
	buildDirectionAnalysisPrompt,
	buildRepositoryAnalysisPrompt,
	buildRepositoryAuditPrompt,
	parseClassificationBatch,
	parseRepositoryCandidates,
	parseRepositoryContribution,
} from "./skill-runtime.ts";
import { resolveRepositoryAttribution } from "./repository-attribution.ts";
import { buildRepositoryInventories } from "./repository-inventory.ts";
import { analyzeSessionEntries } from "./session-analysis.ts";
import type {
	AnalysisScopeOptions,
	PromptClassification,
	RepoInsightsResult,
	RepositoryAttribution,
	RepositoryContributionDraft,
	RepositoryGuidanceResult,
	RepositoryIssueCandidate,
	RepositoryThreadLookup,
	SessionEvidence,
	SessionSource,
} from "./types.ts";

export type AnalysisPhase =
	| "sessions"
	| "repositories"
	| "classification"
	| "candidateAnalysis"
	| "audit"
	| "proposal";

export type AnalysisProgress = {
	phase: AnalysisPhase;
	completed: number;
	total: number;
};

export type AnalyzeOptions = AnalysisScopeOptions & {
	currentSessionId?: string;
	now?: Date;
	concurrency?: number;
	onProgress?: (progress: AnalysisProgress) => void;
};

export type SessionLoader = (source: SessionSource) => Promise<unknown[]>;
export type SkillModelCall = (prompt: string) => Promise<string>;
export type RepositoryAuditResult = {
	response: string;
	lookups: RepositoryThreadLookup[];
	guidance: RepositoryGuidanceResult[];
};
export type RepositoryAuditCall = (
	prompt: string,
	candidate: RepositoryIssueCandidate,
	repository: RepositoryAttribution,
) => Promise<RepositoryAuditResult>;

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

type AuditOptions = {
	candidates: RepositoryIssueCandidate[];
	repositories: RepositoryAttribution[];
	audit: RepositoryAuditCall;
	analysisSkill: string;
	onProgress: AnalyzeOptions["onProgress"];
};

type AuditOutput = {
	contributions: RepositoryContributionDraft[];
	lookups: RepositoryThreadLookup[];
	guidance: RepositoryGuidanceResult[];
};

async function auditContributions(options: AuditOptions): Promise<AuditOutput> {
	const repositoryByKey = new Map(
		options.repositories.map((repository) => [repository.key, repository]),
	);
	const requests = options.candidates.flatMap((candidate) => {
		const repository = repositoryByKey.get(candidate.repository);
		return repository
			? [{ request: buildRepositoryAuditPrompt(candidate, options.analysisSkill), repository }]
			: [];
	});
	options.onProgress?.({ phase: "audit", completed: 0, total: requests.length });
	const contributions: RepositoryContributionDraft[] = [];
	const lookups: RepositoryThreadLookup[] = [];
	const guidance: RepositoryGuidanceResult[] = [];
	let completed = 0;
	const concurrency = 4;
	for (let index = 0; index < requests.length; index += concurrency) {
		const batch = requests.slice(index, index + concurrency);
		const results = await Promise.all(
			batch.map(async ({ request, repository }, batchIndex) => {
				const result = await options.audit(
					request.prompt,
					request.candidate,
					repository,
				);
				const contribution = parseRepositoryContribution(
					result.response,
					request,
					result.lookups,
					result.guidance,
					index + batchIndex + 1,
				);
				completed++;
				options.onProgress?.({
					phase: "audit",
					completed,
					total: requests.length,
				});
				return {
					contribution,
					lookups: result.lookups,
					guidance: result.guidance,
				};
			}),
		);
		for (const result of results) {
			lookups.push(...result.lookups);
			guidance.push(...result.guidance);
			if (result.contribution) contributions.push(result.contribution);
		}
	}
	return {
		contributions: contributions.sort((a, b) =>
			a.repository.localeCompare(b.repository),
		),
		lookups,
		guidance,
	};
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
	auditRepositoryContribution: RepositoryAuditCall,
	classifierSkill: string,
	repositoryAnalysisSkill: string,
	options: AnalyzeOptions,
): Promise<RepoInsightsResult> {
	const selected = selectedSources(sources, options);
	const sessions = await loadSessions(selected, loadEntries, options);
	options.onProgress?.({ phase: "repositories", completed: 0, total: 2 });
	const { repositories, repositoryKeysBySession } =
		await resolveRepositoryAttribution(sessions);
	options.onProgress?.({ phase: "repositories", completed: 1, total: 2 });
	const inventories = await buildRepositoryInventories(repositories);
	options.onProgress?.({ phase: "repositories", completed: 2, total: 2 });

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
	const repositoryAnalysisRequest = buildRepositoryAnalysisPrompt(
		classifications,
		repositories,
		inventories,
		repositoryAnalysisSkill,
	);
	let candidates: RepositoryIssueCandidate[] = [];
	if (repositoryAnalysisRequest) {
		options.onProgress?.({ phase: "candidateAnalysis", completed: 0, total: 1 });
		candidates = parseRepositoryCandidates(
			await analyzeRepositoryInsights(repositoryAnalysisRequest.prompt),
			repositoryAnalysisRequest,
		);
		options.onProgress?.({ phase: "candidateAnalysis", completed: 1, total: 1 });
	}
	const audit = await auditContributions({
		candidates,
		repositories,
		audit: auditRepositoryContribution,
		analysisSkill: repositoryAnalysisSkill,
		onProgress: options.onProgress,
	});
	options.onProgress?.({ phase: "proposal", completed: 1, total: 1 });

	return {
		analysisMode: "history",
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
		inventories,
		classifications,
		threadLookups: audit.lookups,
		guidanceResults: audit.guidance,
		contributions: audit.contributions,
	};
}

export async function analyzeRepositoryDirection(
	cwd: string,
	direction: string,
	analyzeRepositoryInsights: SkillModelCall,
	auditRepositoryContribution: RepositoryAuditCall,
	repositoryAnalysisSkill: string,
	onProgress?: AnalyzeOptions["onProgress"],
): Promise<RepoInsightsResult> {
	const timestamp = new Date().toISOString();
	const evidence: SessionEvidence = {
		sessionId: "direction",
		sessionPath: "",
		cwd,
		startedAt: timestamp,
		modifiedAt: timestamp,
		prompts: [],
		githubRepositories: [],
		referencedPaths: [cwd],
	};
	onProgress?.({ phase: "repositories", completed: 0, total: 2 });
	const { repositories } = await resolveRepositoryAttribution([evidence]);
	onProgress?.({ phase: "repositories", completed: 1, total: 2 });
	const inventories = await buildRepositoryInventories(repositories);
	onProgress?.({ phase: "repositories", completed: 2, total: 2 });
	const request = buildDirectionAnalysisPrompt(
		direction,
		repositories,
		inventories,
		repositoryAnalysisSkill,
	);
	let candidates: RepositoryIssueCandidate[] = [];
	if (request) {
		onProgress?.({ phase: "candidateAnalysis", completed: 0, total: 1 });
		candidates = parseRepositoryCandidates(
			await analyzeRepositoryInsights(request.prompt),
			request,
		);
		onProgress?.({ phase: "candidateAnalysis", completed: 1, total: 1 });
	}
	const audit = await auditContributions({
		candidates,
		repositories,
		audit: auditRepositoryContribution,
		analysisSkill: repositoryAnalysisSkill,
		onProgress,
	});
	onProgress?.({ phase: "proposal", completed: 1, total: 1 });
	return {
		analysisMode: "direction",
		sessions: {
			discovered: 0,
			analyzed: 0,
			skipped: 0,
			promptsAnalyzed: 0,
			promptsClassified: 0,
			promptCharactersSubmitted: 0,
			promptInputTruncated: false,
		},
		repositories,
		inventories,
		classifications: [],
		threadLookups: audit.lookups,
		guidanceResults: audit.guidance,
		contributions: audit.contributions,
	};
}
