// SPDX-License-Identifier: MPL-2.0

const OPERATION_NAMES = [
	"github_run_observation",
	"github_workflow_dispatch",
	"github_pr_inspection",
	"github_issue_edit",
	"git_status",
	"git_diff",
	"test_execution",
	"worktree_management",
] as const;

type OperationName = (typeof OPERATION_NAMES)[number];

export type OperationCounts = Record<OperationName, number>;

export type SessionEvidence = {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	startedAt: string;
	modifiedAt: string;
	toolCalls: number;
	toolErrors: number;
	operationCounts: OperationCounts;
	githubRepositories: string[];
	referencedPaths: string[];
	modifiedPaths: string[];
	workspaceRootErrors: number;
};

export type SessionSource = {
	id: string;
	path: string;
	cwd: string;
	created: Date;
	modified: Date;
};

export type RepositoryActivity = {
	sessionIds: string[];
	pathReferences: number;
	modifiedPathReferences: number;
	githubReferences: number;
};

type WorkflowFileFacts = {
	path: string;
	lines: number;
};

export type WorkflowFacts = {
	count: number;
	totalLines: number;
	manualDispatchCount: number;
	reusableWorkflowCount: number;
	checkoutUses: number;
	largest: WorkflowFileFacts[];
};

export type DependencyReference = {
	target: string;
	version: string;
	manifest: string;
	isPrerelease: boolean;
};

export type RepositoryFacts = {
	key: string;
	name: string;
	root?: string;
	checkoutRoots: string[];
	remote?: string;
	github?: string;
	activity: RepositoryActivity;
	manifests: string[];
	modules: string[];
	moduleCount: number;
	testFileCount: number;
	scannedFileCount: number;
	fileScanTruncated: boolean;
	validationEntrypoints: string[];
	workflows: WorkflowFacts;
	dependencies: DependencyReference[];
};

export type WorkspaceFacts = {
	cwd: string;
	sessionCount: number;
	isGitRepository: boolean;
	repositories: string[];
	localRepositories: string[];
	localRepositoryCount: number;
	operationCounts: OperationCounts;
	workspaceRootErrors: number;
};

export type DependencyEdge = {
	from: string;
	to: string;
	version: string;
	manifest: string;
	isPrerelease: boolean;
};

export type Opportunity = {
	id: string;
	title: string;
	scope: string;
	confidence: "high" | "medium";
	evidence: string[];
	recommendation: string;
};

export type ReportOptions = {
	sinceDays: number;
	maxSessions: number;
};

export type RepoInsightsReport = {
	schemaVersion: 1;
	generatedAt: string;
	options: ReportOptions;
	sessions: {
		discovered: number;
		analyzed: number;
		skipped: number;
	};
	workspaces: WorkspaceFacts[];
	repositories: RepositoryFacts[];
	dependencyEdges: DependencyEdge[];
	opportunities: Opportunity[];
	methodology: string[];
};

export function emptyOperationCounts(): OperationCounts {
	return {
		github_run_observation: 0,
		github_workflow_dispatch: 0,
		github_pr_inspection: 0,
		github_issue_edit: 0,
		git_status: 0,
		git_diff: 0,
		test_execution: 0,
		worktree_management: 0,
	};
}
