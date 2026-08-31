// SPDX-License-Identifier: MPL-2.0

import { buildOpportunities } from "./opportunities.ts";
import {
	buildDependencyEdges,
	buildWorkspaceFacts,
	discoverAndInspectRepositories,
} from "./repository-analysis.ts";
import { analyzeSessionEntries } from "./session-analysis.ts";
import type {
	RepoInsightsReport,
	ReportOptions,
	SessionEvidence,
	SessionSource,
} from "./types.ts";

export type AnalysisPhase = "sessions" | "repositories" | "report";

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

function selectedSources(
	sources: SessionSource[],
	options: AnalyzeOptions,
): SessionSource[] {
	const now = (options.now ?? new Date()).getTime();
	const cutoff = options.sinceDays > 0
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

async function analyzeSessions(
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
		for (const result of results) if (result) sessions.push(result);
	}
	return sessions.sort(
		(a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.sessionId.localeCompare(b.sessionId),
	);
}

export async function analyzeRepositoryHistory(
	sources: SessionSource[],
	loadEntries: SessionLoader,
	options: AnalyzeOptions,
): Promise<RepoInsightsReport> {
	const selected = selectedSources(sources, options);
	const sessions = await analyzeSessions(selected, loadEntries, options);
	options.onProgress?.({ phase: "repositories", completed: 0, total: 1 });
	const repositories = await discoverAndInspectRepositories(sessions);
	const dependencyEdges = buildDependencyEdges(repositories);
	const workspaces = buildWorkspaceFacts(sessions, repositories);
	options.onProgress?.({ phase: "repositories", completed: 1, total: 1 });
	const opportunities = buildOpportunities(workspaces, repositories, dependencyEdges);
	options.onProgress?.({ phase: "report", completed: 1, total: 1 });

	return {
		schemaVersion: 1,
		generatedAt: (options.now ?? new Date()).toISOString(),
		options: {
			sinceDays: options.sinceDays,
			maxSessions: options.maxSessions,
		},
		sessions: {
			discovered: sources.length,
			analyzed: sessions.length,
			skipped: sources.length - sessions.length,
		},
		workspaces,
		repositories,
		dependencyEdges,
		opportunities,
		methodology: [
			"Session JSONL is parsed locally. Prompt text, assistant prose, file contents, and full shell commands are not copied into the report.",
			"Repository identity comes from referenced local paths, Git roots, origin remotes, and explicit GitHub repository references.",
			"Local repository inspection is bounded to 50,000 files per repository and records manifests, test-like files, validation entrypoints, GitHub workflow facts, and Go dependency edges.",
			"The analysis makes no model calls and performs no GitHub API or other network requests.",
			"Session duration, token volume, ordinary test failures, and the use of worktrees are descriptive or neutral; they do not independently produce recommendations.",
			"Repository instruction and context files are not read, generated, or recommended.",
		],
	};
}
