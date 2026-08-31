// SPDX-License-Identifier: MPL-2.0

import type {
	RepoInsightsReport,
	RepositoryFacts,
	WorkspaceFacts,
} from "./types.ts";

function code(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``;
}

function tableCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function repositoryLabel(repository: RepositoryFacts): string {
	return repository.github ?? repository.name;
}

function operationSummary(workspace: WorkspaceFacts): string {
	const parts = [
		["run observations", workspace.operationCounts.github_run_observation],
		["workflow dispatches", workspace.operationCounts.github_workflow_dispatch],
		["PR inspections", workspace.operationCounts.github_pr_inspection],
		["issue edits", workspace.operationCounts.github_issue_edit],
		["test executions", workspace.operationCounts.test_execution],
	] as const;
	return (
		parts
			.flatMap(([label, count]) => (count > 0 ? [`${count} ${label}`] : []))
			.join(", ") || "none detected"
	);
}

function renderWorkspaces(report: RepoInsightsReport): string[] {
	if (report.workspaces.length === 0) return ["No workspaces were resolved."];
	const lines = [
		"| Workspace | Sessions | Git root | Repositories (local/all) | Observed operations |",
		"|---|---:|:---:|---:|---|",
	];
	for (const workspace of report.workspaces) {
		lines.push(
			`| ${tableCell(code(workspace.cwd))} | ${workspace.sessionCount} | ${workspace.isGitRepository ? "yes" : "no"} | ${workspace.localRepositoryCount}/${workspace.repositories.length} | ${tableCell(operationSummary(workspace))} |`,
		);
	}
	return lines;
}

function renderRepositories(report: RepoInsightsReport): string[] {
	if (report.repositories.length === 0) return ["No repositories were resolved."];
	const lines = [
		"| Repository | Sessions | Local | Modules | Test-like files | Workflows (manual/reusable) | Validation entrypoints |",
		"|---|---:|:---:|---:|---:|---:|---|",
	];
	for (const repository of report.repositories) {
		const workflows = `${repository.workflows.count} (${repository.workflows.manualDispatchCount}/${repository.workflows.reusableWorkflowCount})`;
		const entrypoints = repository.validationEntrypoints.length
			? repository.validationEntrypoints.slice(0, 4).map(code).join(", ")
			: "none detected";
		lines.push(
			`| ${tableCell(repositoryLabel(repository))} | ${repository.activity.sessionIds.length} | ${repository.root ? "yes" : "no"} | ${repository.moduleCount} | ${repository.testFileCount}${repository.fileScanTruncated ? "+" : ""} | ${workflows} | ${tableCell(entrypoints)} |`,
		);
	}
	return lines;
}

function renderDependencies(report: RepoInsightsReport): string[] {
	if (report.dependencyEdges.length === 0) {
		return ["No cross-repository dependency edges were resolved from local manifests."];
	}
	const limit = 100;
	const lines = [
		"| From | To | Version | Manifest |",
		"|---|---|---|---|",
	];
	for (const edge of report.dependencyEdges.slice(0, limit)) {
		lines.push(
			`| ${tableCell(edge.from)} | ${tableCell(edge.to)} | ${tableCell(code(edge.version))} | ${tableCell(code(edge.manifest))} |`,
		);
	}
	if (report.dependencyEdges.length > limit) {
		lines.push(
			`\n_${report.dependencyEdges.length - limit} additional edges are present in the JSON report._`,
		);
	}
	return lines;
}

function renderOpportunities(report: RepoInsightsReport): string[] {
	if (report.opportunities.length === 0) {
		return [
			"No opportunity crossed the deterministic evidence thresholds. This is not a claim that the repositories need no improvement.",
		];
	}
	const lines: string[] = [];
	for (const [index, opportunity] of report.opportunities.entries()) {
		lines.push(
			`### ${index + 1}. ${opportunity.title}`,
			"",
			`**Scope:** ${code(opportunity.scope)}  `,
			`**Confidence:** ${opportunity.confidence}`,
			"",
			"**Evidence**",
			"",
			...opportunity.evidence.map((item) => `- ${item}`),
			"",
			"**Repository-level action**",
			"",
			opportunity.recommendation,
			"",
		);
	}
	return lines;
}

export function renderMarkdown(report: RepoInsightsReport): string {
	return [
		"# Pi Repository Insights",
		"",
		`Generated: ${report.generatedAt}`,
		"",
		`Analyzed ${report.sessions.analyzed} of ${report.sessions.discovered} discovered sessions; ${report.sessions.skipped} were skipped or outside the selected window.`,
		"",
		"> Session elapsed time is deliberately not scored. Waiting, pauses, monitoring, and sustained context can all make a session long without making it inefficient.",
		"",
		"## Workspaces",
		"",
		...renderWorkspaces(report),
		"",
		"## Repositories",
		"",
		...renderRepositories(report),
		"",
		"A trailing `+` on the test-like file count means the bounded repository scan reached its file limit.",
		"",
		"## Cross-repository dependency edges",
		"",
		...renderDependencies(report),
		"",
		"## Evidence-backed opportunities",
		"",
		...renderOpportunities(report),
		"## Methodology",
		"",
		...report.methodology.map((item) => `- ${item}`),
		"",
	].join("\n");
}
