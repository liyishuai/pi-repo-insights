// SPDX-License-Identifier: MPL-2.0

export type PromptRecord = {
	index: number;
	timestamp?: string;
	text: string;
};

export type SessionEvidence = {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	startedAt: string;
	modifiedAt: string;
	prompts: PromptRecord[];
	githubRepositories: string[];
	referencedPaths: string[];
};

export type SessionSource = {
	id: string;
	path: string;
	cwd: string;
	created: Date;
	modified: Date;
};

export type RepositoryAttribution = {
	key: string;
	name: string;
	root?: string;
	github?: string;
	checkoutCount: number;
	sessionIds: string[];
};

export type PromptKind =
	| "request"
	| "steering"
	| "response"
	| "other"
	| "unclear";

export type SteeringCategory =
	| "course_correction"
	| "scope_reassertion"
	| "frustration"
	| "missed_requirement"
	| "unwanted_action"
	| "premature_completion"
	| "evidence_challenge";

export type PromptClassification = {
	id: string;
	sessionId: string;
	promptIndex: number;
	kind: PromptKind;
	paraphrase: string;
	confidence: "high" | "medium";
	repositories: string[];
	steeringCategory?: SteeringCategory;
	expectedBehavior?: string;
};

export type SteeringTheme = {
	id: string;
	title: string;
	summary: string;
	promptIds: string[];
	repositories: string[];
	repositoryAction?: string;
};

export type ReportOptions = {
	sinceDays: number;
	maxSessions: number;
	modelCatalog?: "scoped" | "all";
	classifierModel?: string;
	analysisModel?: string;
};

export type RepoInsightsReport = {
	schemaVersion: 2;
	generatedAt: string;
	options: ReportOptions;
	classifierModel: string;
	analysisModel: string;
	sessions: {
		discovered: number;
		analyzed: number;
		skipped: number;
		promptsAnalyzed: number;
		promptsClassified: number;
		promptCharactersSubmitted: number;
		promptInputTruncated: boolean;
	};
	repositories: RepositoryAttribution[];
	classifications: PromptClassification[];
	themes: SteeringTheme[];
	methodology: string[];
};
