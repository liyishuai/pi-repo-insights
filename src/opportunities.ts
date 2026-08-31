// SPDX-License-Identifier: MPL-2.0

import type {
	DependencyEdge,
	Opportunity,
	RepositoryFacts,
	WorkspaceFacts,
} from "./types.ts";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function workspaceScope(workspace: WorkspaceFacts): string {
	return workspace.cwd;
}

function workspaceManifestOpportunity(
	workspace: WorkspaceFacts,
): Opportunity | undefined {
	if (workspace.isGitRepository || workspace.localRepositoryCount < 2) return undefined;
	const evidence = [
		`${plural(workspace.sessionCount, "session")} originated from a non-Git workspace that referenced ${plural(workspace.localRepositoryCount, "local repository", "local repositories")}.`,
		`Repositories: ${workspace.localRepositories.slice(0, 12).join(", ")}${workspace.localRepositories.length > 12 ? ", …" : ""}.`,
	];
	if (workspace.workspaceRootErrors > 0) {
		evidence.push(
			`${plural(workspace.workspaceRootErrors, "tool result")} reported that the workspace root was not a Git repository.`,
		);
	}
	return {
		id: `workspace-manifest:${workspace.cwd}`,
		title: "Add a versioned multi-repository workspace manifest",
		scope: workspaceScope(workspace),
		confidence: "high",
		evidence,
		recommendation:
			"Put a machine-readable manifest in an owning repository that maps repository slug, local directory, role, default branch, dependency order, and the repository's canonical validation command. Validate the manifest in CI and let local tooling consume it; do not encode this contract in personal agent configuration.",
	};
}

function ciObservationOpportunity(
	workspace: WorkspaceFacts,
): Opportunity | undefined {
	const observations = workspace.operationCounts.github_run_observation;
	if (observations < 10) return undefined;
	return {
		id: `ci-summary:${workspace.cwd}`,
		title: "Publish one structured cross-repository CI status record",
		scope: workspaceScope(workspace),
		confidence: "high",
		evidence: [
			`${plural(observations, "GitHub Actions observation")} used run view, list, or watch operations.`,
			`${plural(workspace.operationCounts.github_workflow_dispatch, "workflow dispatch", "workflow dispatches")} and ${plural(workspace.operationCounts.github_pr_inspection, "pull-request inspection")} occurred in the same workspace.`,
		],
		recommendation:
			"Have the repositories emit or update one bounded JSON status artifact when workflows settle. Include repository/head identity, required checks, artifact digests, deployment identity, and terminal conclusions. Monitoring remains valid; the improvement is replacing repeated manual correlation with one repository-owned state record.",
	};
}

function promotionStateOpportunity(
	workspace: WorkspaceFacts,
): Opportunity | undefined {
	const edits = workspace.operationCounts.github_issue_edit;
	const inspections = workspace.operationCounts.github_pr_inspection;
	if (edits < 3 || inspections < 10 || workspace.localRepositoryCount < 2) {
		return undefined;
	}
	return {
		id: `promotion-state:${workspace.cwd}`,
		title: "Generate tracker prose from versioned promotion state",
		scope: workspaceScope(workspace),
		confidence: "medium",
		evidence: [
			`${plural(edits, "issue-body edit")} accompanied ${plural(inspections, "pull-request inspection")} across ${plural(workspace.localRepositoryCount, "local repository", "local repositories")}.`,
		],
		recommendation:
			"Store the mutable promotion tuple—repositories, reviewed heads, release tags, artifact digests, required gates, and owner-controlled transitions—as schema-validated JSON. Render the human issue summary from that state and reject stale or contradictory tuples in CI.",
	};
}

function dependencyClosureOpportunity(
	edges: DependencyEdge[],
): Opportunity | undefined {
	const repositoryPairs = new Set(edges.map((edge) => `${edge.from}\u0000${edge.to}`));
	const prerelease = edges.filter((edge) => edge.isPrerelease);
	if (repositoryPairs.size < 3 && prerelease.length < 3) return undefined;
	return {
		id: "dependency-closure",
		title: "Automate the cross-repository dependency closure",
		scope: "repository set",
		confidence: "high",
		evidence: [
			`${plural(edges.length, "detected local dependency pin")} connect ${plural(repositoryPairs.size, "repository pair")}.`,
			`${plural(prerelease.length, "pin")} use prerelease or pseudo-version identifiers.`,
		],
		recommendation:
			"Add a repository-owned closure command that resolves the exact reviewed commit, immutable release, and downstream pin for every edge, then emits a signed or checksummed manifest consumed by release CI. Fail when source heads, dependency pins, or deployment artifacts disagree.",
	};
}

function validationEntrypointOpportunity(
	repositories: RepositoryFacts[],
): Opportunity | undefined {
	const missing = repositories.filter(
		(repository) =>
			repository.root !== undefined &&
			repository.testFileCount > 0 &&
			repository.workflows.count > 0 &&
			repository.validationEntrypoints.length === 0,
	);
	if (missing.length === 0) return undefined;
	return {
		id: "validation-entrypoints",
		title: "Expose one CI-parity validation entrypoint per repository",
		scope: missing.map((repository) => repository.key).join(", "),
		confidence: "medium",
		evidence: missing.slice(0, 10).map(
			(repository) =>
				`${repository.key}: ${plural(repository.testFileCount, "test-like file")}, ${plural(repository.workflows.count, "workflow")}, and no detected Make/Task/just/scripts-check or package check/ci/test/verify entrypoint.`,
		),
		recommendation:
			"Give each repository one documented executable command that selects the same format, generation, unit, integration, and boundary checks as CI. Make CI call that command rather than maintaining a second command graph in workflow YAML.",
	};
}

function workflowSurfaceOpportunities(
	repositories: RepositoryFacts[],
): Opportunity[] {
	return repositories.flatMap((repository) => {
		if (
			!repository.root ||
			repository.workflows.manualDispatchCount < 10 ||
			repository.workflows.totalLines < 3_000
		) {
			return [];
		}
		return [
			{
				id: `workflow-interface:${repository.key}`,
				title: "Publish a typed operations index for manual workflows",
				scope: repository.key,
				confidence: "medium" as const,
				evidence: [
					`${plural(repository.workflows.manualDispatchCount, "manually dispatched workflow")} span ${repository.workflows.totalLines.toLocaleString()} workflow lines.`,
					`${plural(repository.workflows.reusableWorkflowCount, "reusable workflow")} and ${plural(repository.workflows.checkoutUses, "checkout step")} were detected.`,
				],
				recommendation:
					"Generate a versioned operations index from workflow inputs that classifies environment, mutability, required identity fields, owner boundary, and terminal evidence. Provide a preflight/status CLI over that index. Factor shared workflow code only where measured duplication justifies it.",
			},
		];
	});
}

export function buildOpportunities(
	workspaces: WorkspaceFacts[],
	repositories: RepositoryFacts[],
	dependencyEdges: DependencyEdge[],
): Opportunity[] {
	const opportunities: Opportunity[] = [];
	for (const workspace of workspaces) {
		const workspaceManifest = workspaceManifestOpportunity(workspace);
		if (workspaceManifest) opportunities.push(workspaceManifest);
		const ciObservation = ciObservationOpportunity(workspace);
		if (ciObservation) opportunities.push(ciObservation);
		const promotionState = promotionStateOpportunity(workspace);
		if (promotionState) opportunities.push(promotionState);
	}
	const dependencyClosure = dependencyClosureOpportunity(dependencyEdges);
	if (dependencyClosure) opportunities.push(dependencyClosure);
	const validationEntrypoint = validationEntrypointOpportunity(repositories);
	if (validationEntrypoint) opportunities.push(validationEntrypoint);
	opportunities.push(...workflowSurfaceOpportunities(repositories));
	return opportunities;
}
