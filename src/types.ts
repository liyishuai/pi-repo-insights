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

export type RepositoryIssueCandidate = {
	repository: string;
	title: string;
	currentStatus: string;
	agentImpact: string;
	proposal: string[];
	acceptanceCriteria: string[];
	body: string;
	promptIds: string[];
	searchQueries: string[];
};

export type GitHubThreadSummary = {
	ref: string;
	kind: "issue" | "pull_request";
	number: number;
	title: string;
	url: string;
	bodyExcerpt: string;
	updatedAt?: string;
};

export type RepositoryThreadLookup = {
	repository: string;
	status: "success" | "failed" | "unsupported";
	source?: "gh" | "rest";
	query?: string;
	threads: GitHubThreadSummary[];
	error?: string;
};

export type RepositoryGuidanceFile = {
	path: string;
	content: string;
};

export type RepositoryGuidanceResult = {
	repository: string;
	status: "success" | "failed" | "unsupported";
	source?: "local" | "gh" | "rest";
	files: RepositoryGuidanceFile[];
	error?: string;
};

export type RepositoryContributionDraft = {
	id: string;
	kind: "issue" | "existing";
	repository: string;
	title: string;
	body: string;
	labels: string[];
	promptIds: string[];
	existingThread?: {
		kind: "issue" | "pull_request";
		number: number;
		title: string;
		url: string;
	};
};

export type AnalysisScopeOptions = {
	sinceDays: number;
	maxSessions: number;
	modelCatalog?: "scoped" | "all";
	classifierModel?: string;
	analysisModel?: string;
};

export type RepoInsightsResult = {
	analysisMode: "history" | "direction";
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
	threadLookups: RepositoryThreadLookup[];
	guidanceResults: RepositoryGuidanceResult[];
	contributions: RepositoryContributionDraft[];
};
