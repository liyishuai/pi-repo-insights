// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOpportunities } from "../src/opportunities.ts";
import { parseCommandOptions } from "../src/options.ts";
import {
	buildDependencyEdges,
	buildWorkspaceFacts,
	discoverAndInspectRepositories,
	parseGitHubRemote,
} from "../src/repository-analysis.ts";
import { renderMarkdown } from "../src/report.ts";
import {
	analyzeSessionEntries,
	extractGitHubRepositories,
} from "../src/session-analysis.ts";
import {
	emptyOperationCounts,
	type RepoInsightsReport,
	type SessionEvidence,
} from "../src/types.ts";

const source = {
	id: "session-1",
	path: "/sessions/session-1.jsonl",
	cwd: "/workspace",
	created: new Date("2026-01-01T00:00:00.000Z"),
	modified: new Date("2026-01-01T01:00:00.000Z"),
};

test("session analysis extracts repository evidence without retaining prose", () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Investigate https://github.com/acme/service/issues/42 secret prose" }],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: {
							command: "cd service && gh run view 123 --repo acme/service",
						},
					},
					{
						type: "toolCall",
						id: "call-2",
						name: "edit",
						arguments: { path: "service/src/main.ts", edits: [] },
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "duplicate branch entry" },
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "fatal: not a git repository" }],
			},
		},
	];
	const evidence = analyzeSessionEntries(entries, source);
	assert.deepEqual(evidence.githubRepositories, ["acme/service"]);
	assert.equal(evidence.toolCalls, 2);
	assert.equal(evidence.operationCounts.github_run_observation, 1);
	assert.equal(evidence.workspaceRootErrors, 1);
	assert.ok(evidence.referencedPaths.includes("/workspace/service"));
	assert.ok(evidence.modifiedPaths.includes("/workspace/service/src/main.ts"));
	assert.equal(JSON.stringify(evidence).includes("secret prose"), false);
});

test("GitHub repository parsing handles web, API, SSH, and gh forms", () => {
	assert.deepEqual(
		extractGitHubRepositories(
			"https://github.com/a/one/pull/2 https://api.github.com/repos/b/two/actions git@github.com:c/three.git gh pr view -R d/four",
		),
		["a/one", "b/two", "c/three", "d/four"],
	);
	assert.equal(parseGitHubRemote("git@github.com:owner/repository.git"), "owner/repository");
	assert.equal(parseGitHubRemote("https://github.com/owner/repository.git"), "owner/repository");
});

test("command options are bounded and resolve relative output paths", () => {
	const parsed = parseCommandOptions(
		"--since 30d --max-sessions 500 --output reports/repo",
		"/workspace",
	);
	assert.deepEqual(parsed, {
		kind: "run",
		options: {
			sinceDays: 30,
			maxSessions: 500,
			outputDirectory: "/workspace/reports/repo",
		},
	});
	assert.equal(parseCommandOptions("--max-sessions 0", "/workspace").kind, "error");
	assert.equal(parseCommandOptions("--unknown", "/workspace").kind, "error");
});

async function createGitRepository(
	root: string,
	name: string,
	goMod: string,
	githubName = name,
): Promise<string> {
	const directory = join(root, name);
	await mkdir(join(directory, ".github", "workflows"), { recursive: true });
	await writeFile(join(directory, "go.mod"), goMod);
	await writeFile(join(directory, "main_test.go"), "package main\n");
	await writeFile(
		join(directory, ".github", "workflows", "ci.yml"),
		"on:\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
	);
	execFileSync("git", ["init", "-q", directory]);
	execFileSync("git", [
		"-C",
		directory,
		"remote",
		"add",
		"origin",
		`git@github.com:acme/${githubName}.git`,
	]);
	return realpath(directory);
}

function fixtureSession(
	workspace: string,
	repoA: string,
	repoB: string,
	extraPaths: string[] = [],
): SessionEvidence {
	const operationCounts = emptyOperationCounts();
	operationCounts.github_run_observation = 12;
	operationCounts.github_pr_inspection = 11;
	operationCounts.github_issue_edit = 3;
	return {
		sessionId: "fixture-session",
		sessionPath: "/sessions/fixture.jsonl",
		cwd: workspace,
		startedAt: "2026-01-01T00:00:00.000Z",
		modifiedAt: "2026-01-01T01:00:00.000Z",
		toolCalls: 40,
		toolErrors: 1,
		operationCounts,
		githubRepositories: ["acme/repo-a", "acme/repo-b"],
		referencedPaths: [join(repoA, "main_test.go"), join(repoB, "main_test.go"), ...extraPaths],
		modifiedPaths: [join(repoA, "main_test.go")],
		workspaceRootErrors: 1,
	};
}

test("repository inspection resolves a multi-repo workspace and dependency edge", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-repo-insights-test-"));
	try {
		const repoB = await createGitRepository(
			workspace,
			"repo-b",
			"module github.com/acme/repo-b\n\ngo 1.24\n",
		);
		const repoA = await createGitRepository(
			workspace,
			"repo-a",
			"module github.com/acme/repo-a\n\ngo 1.24\n\nrequire github.com/acme/repo-b v0.0.0-20260101000000-abcdef123456\n",
		);
		const repoAWorktree = await createGitRepository(
			join(workspace, ".worktrees"),
			"repo-a-copy",
			"module github.com/acme/repo-a\n\ngo 1.24\n\nrequire github.com/acme/repo-b v9.9.9\n",
			"repo-a",
		);
		await createGitRepository(
			repoA,
			"nested-checkout",
			"module github.com/acme/nested-checkout\n\ngo 1.24\n\nrequire github.com/acme/repo-b v8.8.8\n",
		);
		const session = fixtureSession(workspace, repoA, repoB, [
			join(repoAWorktree, "main_test.go"),
		]);
		const repositories = await discoverAndInspectRepositories([session]);
		assert.deepEqual(
			repositories
				.map((repository) => repository.github)
				.sort((a, b) => (a ?? "").localeCompare(b ?? "")),
			["acme/repo-a", "acme/repo-b"],
		);
		const repoAFacts = repositories.find(
			(repository) => repository.github === "acme/repo-a",
		);
		assert.equal(repoAFacts?.root, repoA);
		assert.deepEqual(repoAFacts?.checkoutRoots, [repoAWorktree, repoA].sort((a, b) => a.localeCompare(b)));
		assert.equal(repoAFacts?.testFileCount, 1);
		const edges = buildDependencyEdges(repositories);
		assert.deepEqual(edges, [
			{
				from: "acme/repo-a",
				to: "acme/repo-b",
				version: "v0.0.0-20260101000000-abcdef123456",
				manifest: "go.mod",
				isPrerelease: true,
			},
		]);
		const workspaces = buildWorkspaceFacts([session], repositories);
		assert.equal(workspaces[0]?.isGitRepository, false);
		assert.deepEqual(workspaces[0]?.repositories, ["acme/repo-a", "acme/repo-b"]);
		assert.deepEqual(workspaces[0]?.localRepositories, ["acme/repo-a", "acme/repo-b"]);
		const opportunities = buildOpportunities(workspaces, repositories, edges);
		assert.ok(opportunities.some((item) => item.id.startsWith("workspace-manifest:")));
		assert.ok(opportunities.some((item) => item.id.startsWith("ci-summary:")));
		assert.ok(opportunities.some((item) => item.id === "validation-entrypoints"));
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("markdown explicitly treats session duration as neutral", () => {
	const report: RepoInsightsReport = {
		schemaVersion: 1,
		generatedAt: "2026-01-01T00:00:00.000Z",
		options: { sinceDays: 0, maxSessions: 200 },
		sessions: { discovered: 1, analyzed: 1, skipped: 0 },
		workspaces: [],
		repositories: [],
		dependencyEdges: [],
		opportunities: [],
		methodology: [],
	};
	const markdown = renderMarkdown(report);
	assert.match(markdown, /Session elapsed time is deliberately not scored/);
	assert.doesNotMatch(markdown, /shorten.*session/i);
});
