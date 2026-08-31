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

export type RepositoryInventory = {
	repository: string;
	topLevelDirectories: string[];
	topLevelFiles: string[];
	manifests: string[];
	ciFiles: string[];
	validationEntrypoints: string[];
	packageScripts: string[];
	filesVisited: number;
	truncated: boolean;
};

export type RepositoryIssueDraft = {
	id: string;
	repository: string;
	title: string;
	currentStatus: string;
	agentImpact: string;
	proposal: string[];
	acceptanceCriteria: string[];
	body: string;
	promptIds: string[];
};

export type ReportOptions = {
	sinceDays: number;
	maxSessions: number;
	modelCatalog?: "scoped" | "all";
	classifierModel?: string;
	analysisModel?: string;
};

export type RepoInsightsReport = {
	schemaVersion: 3;
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
	inventories: RepositoryInventory[];
	classifications: PromptClassification[];
	issues: RepositoryIssueDraft[];
	methodology: string[];
};
