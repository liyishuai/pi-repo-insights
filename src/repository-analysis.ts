// SPDX-License-Identifier: MPL-2.0

import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	emptyOperationCounts,
	type DependencyEdge,
	type DependencyReference,
	type RepositoryActivity,
	type RepositoryFacts,
	type SessionEvidence,
	type WorkflowFacts,
	type WorkspaceFacts,
} from "./types.ts";
import { mergeOperationCounts, normalizeGitHubRepository } from "./session-analysis.ts";

const execFileAsync = promisify(execFile);
const MAX_GIT_CANDIDATES = 600;
const MAX_REPOSITORY_FILES = 50_000;
const IGNORED_DIRECTORIES = new Set([
	".git",
	".worktrees",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"coverage",
	".cache",
	".next",
	".nuxt",
	".output",
]);
const TOP_LEVEL_MANIFESTS = [
	"go.work",
	"go.mod",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"requirements.txt",
];
const VALIDATION_FILES = [
	"Makefile",
	"Taskfile.yml",
	"Taskfile.yaml",
	"justfile",
	"scripts/check",
	"scripts/check.sh",
	"scripts/ci",
	"scripts/ci.sh",
	"scripts/test",
	"scripts/test.sh",
	"scripts/verify",
	"scripts/verify.sh",
];

type CommandResult = { code: number; stdout: string; stderr: string };
type LocalRepository = { root: string; remote?: string; github?: string };
type FileInventory = {
	files: string[];
	goModFiles: string[];
	packageJsonFiles: string[];
	truncated: boolean;
};

async function run(
	command: string,
	args: string[],
	cwd?: string,
): Promise<CommandResult> {
	try {
		const result = await execFileAsync(command, args, {
			cwd,
			timeout: 8_000,
			maxBuffer: 2 * 1024 * 1024,
			encoding: "utf8",
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failed = error as NodeJS.ErrnoException & {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: typeof failed.code === "number" ? failed.code : 1,
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? failed.message,
		};
	}
}

function pathContains(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

async function nearestExistingDirectory(candidate: string): Promise<string | undefined> {
	let current = resolve(candidate);
	for (;;) {
		try {
			const info = await stat(current);
			return info.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

async function gitRootForPath(candidate: string): Promise<string | undefined> {
	const directory = await nearestExistingDirectory(candidate);
	if (!directory) return undefined;
	const result = await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return undefined;
	const root = result.stdout.trim();
	return root ? resolve(root) : undefined;
}

export function parseGitHubRemote(remote: string): string | undefined {
	const patterns = [
		/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
		/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/,
		/^git:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/,
	];
	for (const pattern of patterns) {
		const match = remote.trim().match(pattern);
		const normalized = match?.[1]
			? normalizeGitHubRepository(match[1])
			: undefined;
		if (normalized) return normalized;
	}
	return undefined;
}

async function resolveLocalRepository(root: string): Promise<LocalRepository> {
	const remoteResult = await run("git", ["-C", root, "remote", "get-url", "origin"]);
	const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined;
	return {
		root,
		remote: remote || undefined,
		github: remote ? parseGitHubRemote(remote) : undefined,
	};
}

function candidatePaths(sessions: SessionEvidence[]): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	const add = (value: string) => {
		const normalized = resolve(value);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		ordered.push(normalized);
	};
	for (const session of sessions) add(session.cwd);
	for (const session of sessions) for (const path of session.modifiedPaths) add(path);
	for (const session of sessions) for (const path of session.referencedPaths) add(path);
	return ordered;
}

function emptyActivity(): RepositoryActivity {
	return {
		sessionIds: [],
		pathReferences: 0,
		modifiedPathReferences: 0,
		githubReferences: 0,
	};
}

function activityForRepository(
	repository: LocalRepository,
	sessions: SessionEvidence[],
): RepositoryActivity {
	const activity = emptyActivity();
	for (const session of sessions) {
		const pathReferences = session.referencedPaths.filter((path) =>
			pathContains(repository.root, path),
		).length;
		const modifiedPathReferences = session.modifiedPaths.filter((path) =>
			pathContains(repository.root, path),
		).length;
		const githubReferences = repository.github
			? session.githubRepositories.filter(
					(slug) => slug.toLowerCase() === repository.github?.toLowerCase(),
				).length
			: 0;
		const cwdMatch = pathContains(repository.root, session.cwd);
		if (pathReferences || modifiedPathReferences || githubReferences || cwdMatch) {
			activity.sessionIds.push(session.sessionId);
			activity.pathReferences += pathReferences;
			activity.modifiedPathReferences += modifiedPathReferences;
			activity.githubReferences += githubReferences;
		}
	}
	activity.sessionIds.sort((a, b) => a.localeCompare(b));
	return activity;
}

function shouldKeepLocalRepository(
	repository: LocalRepository,
	activity: RepositoryActivity,
	sessions: SessionEvidence[],
): boolean {
	if (
		activity.modifiedPathReferences > 0 ||
		activity.githubReferences > 0 ||
		activity.sessionIds.some((id) => {
			const session = sessions.find((item) => item.sessionId === id);
			return session ? pathContains(repository.root, session.cwd) : false;
		})
	) {
		return true;
	}

	return sessions.some(
		(session) =>
			pathContains(session.cwd, repository.root) &&
			session.referencedPaths.some((path) => pathContains(repository.root, path)),
	);
}

async function directGitChildren(cwd: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(cwd, { withFileTypes: true });
	} catch {
		return [];
	}
	const children: string[] = [];
	for (const entry of entries.slice(0, 200)) {
		if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
		const child = join(cwd, entry.name);
		try {
			await access(join(child, ".git"));
			children.push(child);
		} catch {
			// Not a direct Git child.
		}
	}
	return children;
}

async function discoverLocalRepositories(
	sessions: SessionEvidence[],
): Promise<LocalRepository[]> {
	const roots = new Set<string>();
	const workspaceChildren: string[] = [];
	for (const cwd of new Set(sessions.map((session) => session.cwd))) {
		workspaceChildren.push(...(await directGitChildren(cwd)));
	}
	const candidates = [...new Set([...workspaceChildren, ...candidatePaths(sessions)])];
	for (const candidate of candidates.slice(0, MAX_GIT_CANDIDATES)) {
		const known = [...roots].find((root) => pathContains(root, candidate));
		if (known) continue;
		const root = await gitRootForPath(candidate);
		if (root) roots.add(root);
	}
	return Promise.all(
		[...roots]
			.sort((a, b) => a.localeCompare(b))
			.map(resolveLocalRepository),
	);
}

async function walkRepository(root: string): Promise<FileInventory> {
	const files: string[] = [];
	const goModFiles: string[] = [];
	const packageJsonFiles: string[] = [];
	const pending = [root];
	let truncated = false;

	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		if (directory !== root && entries.some((entry) => entry.name === ".git")) continue;
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(join(directory, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const path = join(directory, entry.name);
			const rel = relative(root, path).split(sep).join("/");
			files.push(rel);
			if (entry.name === "go.mod") goModFiles.push(rel);
			if (entry.name === "package.json") packageJsonFiles.push(rel);
			if (files.length >= MAX_REPOSITORY_FILES) {
				truncated = true;
				pending.length = 0;
				break;
			}
		}
	}

	return { files, goModFiles, packageJsonFiles, truncated };
}

function isTestLikeFile(path: string): boolean {
	const name = basename(path);
	return (
		/_test\.go$/.test(name) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) ||
		/^test_.*\.py$/.test(name) ||
		/(?:^|\/)tests?\//.test(path)
	);
}

async function existingPaths(root: string, candidates: string[]): Promise<string[]> {
	const found: string[] = [];
	for (const candidate of candidates) {
		try {
			await access(join(root, candidate));
			found.push(candidate);
		} catch {
			// Absent entrypoint.
		}
	}
	return found;
}

async function packageScriptEntrypoints(
	root: string,
	packageJsonFiles: string[],
): Promise<string[]> {
	const entrypoints: string[] = [];
	for (const path of packageJsonFiles.filter((candidate) => candidate === "package.json")) {
		try {
			const parsed = JSON.parse(await readFile(join(root, path), "utf8")) as {
				scripts?: Record<string, unknown>;
			};
			for (const name of ["check", "ci", "test", "verify"]) {
				if (typeof parsed.scripts?.[name] === "string") {
					entrypoints.push(`${path}#scripts.${name}`);
				}
			}
		} catch {
			// Invalid or unreadable package manifests are reported only through absence.
		}
	}
	return entrypoints;
}

async function inspectWorkflows(root: string): Promise<WorkflowFacts> {
	const workflowRoot = join(root, ".github", "workflows");
	let entries;
	try {
		entries = await readdir(workflowRoot, { withFileTypes: true });
	} catch {
		return {
			count: 0,
			totalLines: 0,
			manualDispatchCount: 0,
			reusableWorkflowCount: 0,
			checkoutUses: 0,
			largest: [],
		};
	}

	const largest: Array<{ path: string; lines: number }> = [];
	let totalLines = 0;
	let manualDispatchCount = 0;
	let reusableWorkflowCount = 0;
	let checkoutUses = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
		try {
			const content = await readFile(join(workflowRoot, entry.name), "utf8");
			const lines = content ? content.split("\n").length : 0;
			totalLines += lines;
			if (/^\s*workflow_dispatch\s*:/m.test(content)) manualDispatchCount++;
			if (/^\s*workflow_call\s*:/m.test(content)) reusableWorkflowCount++;
			checkoutUses += (content.match(/actions\/checkout@/g) ?? []).length;
			largest.push({ path: `.github/workflows/${entry.name}`, lines });
		} catch {
			// Ignore a workflow that cannot be read.
		}
	}
	largest.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
	return {
		count: largest.length,
		totalLines,
		manualDispatchCount,
		reusableWorkflowCount,
		checkoutUses,
		largest: largest.slice(0, 5),
	};
}

async function parseGoMod(
	root: string,
	manifest: string,
): Promise<{ module?: string; dependencies: DependencyReference[] }> {
	try {
		const content = await readFile(join(root, manifest), "utf8");
		const module = content.match(/^\s*module\s+(\S+)/m)?.[1];
		const dependencies: DependencyReference[] = [];
		for (const line of content.split("\n")) {
			const match = line.match(
				/^\s*(?:require\s+)?(github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s+(v?[^\s/]+)(?:\s+\/\/.*)?$/,
			);
			if (!match?.[1] || !match[2]) continue;
			dependencies.push({
				target: match[1],
				version: match[2],
				manifest,
				isPrerelease: !/^v?\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(match[2]),
			});
		}
		return { module, dependencies };
	} catch {
		return { dependencies: [] };
	}
}

function githubRepositoryName(github: string): string {
	const [, name] = github.split("/");
	return name ?? github;
}

async function inspectRepository(
	repository: LocalRepository,
	activity: RepositoryActivity,
): Promise<RepositoryFacts> {
	const inventory = await walkRepository(repository.root);
	const manifests = await existingPaths(repository.root, TOP_LEVEL_MANIFESTS);
	const validationFiles = await existingPaths(repository.root, VALIDATION_FILES);
	const packageEntrypoints = await packageScriptEntrypoints(
		repository.root,
		inventory.packageJsonFiles,
	);
	const modules: string[] = [];
	const dependencies: DependencyReference[] = [];
	for (const manifest of inventory.goModFiles) {
		const parsed = await parseGoMod(repository.root, manifest);
		if (parsed.module) modules.push(parsed.module);
		dependencies.push(...parsed.dependencies);
	}

	const github = repository.github;
	const key = github ?? repository.root;
	return {
		key,
		name: github ? githubRepositoryName(github) : basename(repository.root),
		root: repository.root,
		checkoutRoots: [repository.root],
		remote: repository.remote,
		github,
		activity,
		manifests,
		modules: [...new Set(modules)].sort((a, b) => a.localeCompare(b)),
		moduleCount: modules.length,
		testFileCount: inventory.files.filter(isTestLikeFile).length,
		scannedFileCount: inventory.files.length,
		fileScanTruncated: inventory.truncated,
		validationEntrypoints: [...new Set([...validationFiles, ...packageEntrypoints])].sort(
			(a, b) => a.localeCompare(b),
		),
		workflows: await inspectWorkflows(repository.root),
		dependencies,
	};
}

function remoteOnlyRepository(
	github: string,
	sessions: SessionEvidence[],
): RepositoryFacts {
	const activity = emptyActivity();
	for (const session of sessions) {
		const references = session.githubRepositories.filter(
			(slug) => slug.toLowerCase() === github.toLowerCase(),
		).length;
		if (!references) continue;
		activity.sessionIds.push(session.sessionId);
		activity.githubReferences += references;
	}
	return {
		key: github,
		name: githubRepositoryName(github),
		checkoutRoots: [],
		github,
		activity,
		manifests: [],
		modules: [],
		moduleCount: 0,
		testFileCount: 0,
		scannedFileCount: 0,
		fileScanTruncated: false,
		validationEntrypoints: [],
		workflows: {
			count: 0,
			totalLines: 0,
			manualDispatchCount: 0,
			reusableWorkflowCount: 0,
			checkoutUses: 0,
			largest: [],
		},
		dependencies: [],
	};
}

function temporaryRepositoryRoot(root: string): boolean {
	return [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
		.map((path) => resolve(path))
		.some((path) => pathContains(path, root));
}

function repositoryPreference(repository: RepositoryFacts): number {
	if (!repository.root) return 0;
	let score = temporaryRepositoryRoot(repository.root) ? 0 : 100;
	if (
		repository.root.includes(`${sep}.worktrees${sep}`) ||
		repository.root.includes(`${sep}.codex${sep}worktrees${sep}`)
	) {
		score -= 20;
	}
	return score - repository.root.length / 10_000;
}

function mergeRepositoryGroup(group: RepositoryFacts[]): RepositoryFacts {
	const representative = [...group].sort(
		(a, b) => repositoryPreference(b) - repositoryPreference(a),
	)[0];
	if (!representative) throw new Error("Cannot merge an empty repository group");
	return {
		...representative,
		checkoutRoots: [...new Set(group.flatMap((repository) => repository.checkoutRoots))].sort(
			(a, b) => a.localeCompare(b),
		),
		activity: {
			sessionIds: [...new Set(group.flatMap((repository) => repository.activity.sessionIds))].sort(
				(a, b) => a.localeCompare(b),
			),
			pathReferences: group.reduce(
				(total, repository) => total + repository.activity.pathReferences,
				0,
			),
			modifiedPathReferences: group.reduce(
				(total, repository) => total + repository.activity.modifiedPathReferences,
				0,
			),
			githubReferences: Math.max(
				...group.map((repository) => repository.activity.githubReferences),
			),
		},
	};
}

function mergeInspectedRepositories(repositories: RepositoryFacts[]): RepositoryFacts[] {
	const groups = new Map<string, RepositoryFacts[]>();
	for (const repository of repositories) {
		const identity = repository.github?.toLowerCase() ?? repository.key;
		const group = groups.get(identity) ?? [];
		group.push(repository);
		groups.set(identity, group);
	}
	return [...groups.values()].map(mergeRepositoryGroup);
}

export async function discoverAndInspectRepositories(
	sessions: SessionEvidence[],
): Promise<RepositoryFacts[]> {
	const discovered = await discoverLocalRepositories(sessions);
	const kept = discovered
		.map((repository) => ({
			repository,
			activity: activityForRepository(repository, sessions),
		}))
		.filter(({ repository, activity }) =>
			shouldKeepLocalRepository(repository, activity, sessions),
		);
	const inspectedCheckouts = await Promise.all(
		kept.map(({ repository, activity }) => inspectRepository(repository, activity)),
	);
	const inspected = mergeInspectedRepositories(inspectedCheckouts);

	const knownGitHub = new Set(
		inspected.flatMap((repository) =>
			repository.github ? [repository.github.toLowerCase()] : [],
		),
	);
	const referencedGitHub = new Set(
		sessions.flatMap((session) => session.githubRepositories),
	);
	for (const github of [...referencedGitHub].sort((a, b) => a.localeCompare(b))) {
		if (!knownGitHub.has(github.toLowerCase())) {
			inspected.push(remoteOnlyRepository(github, sessions));
		}
	}

	return inspected.sort((a, b) => {
		const sessionDifference = b.activity.sessionIds.length - a.activity.sessionIds.length;
		return sessionDifference || a.key.localeCompare(b.key);
	});
}

export function buildDependencyEdges(
	repositories: RepositoryFacts[],
): DependencyEdge[] {
	const moduleOwners = new Map<string, string>();
	const githubOwners = new Map<string, string>();
	for (const repository of repositories) {
		for (const module of repository.modules) moduleOwners.set(module, repository.key);
		if (repository.github) {
			githubOwners.set(repository.github.toLowerCase(), repository.key);
		}
	}

	const edges = new Map<string, DependencyEdge>();
	for (const repository of repositories) {
		for (const dependency of repository.dependencies) {
			let target = moduleOwners.get(dependency.target);
			if (!target) {
				const parts = dependency.target.split("/");
				const slug = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : undefined;
				target = slug ? githubOwners.get(slug.toLowerCase()) : undefined;
			}
			if (!target || target === repository.key) continue;
			const edge: DependencyEdge = {
				from: repository.key,
				to: target,
				version: dependency.version,
				manifest: dependency.manifest,
				isPrerelease: dependency.isPrerelease,
			};
			edges.set(
				`${edge.from}\u0000${edge.to}\u0000${edge.manifest}\u0000${edge.version}`,
				edge,
			);
		}
	}
	return [...edges.values()].sort(
		(a, b) =>
			a.from.localeCompare(b.from) ||
			a.to.localeCompare(b.to) ||
			a.manifest.localeCompare(b.manifest),
	);
}

function repositoryMatchesSession(
	repository: RepositoryFacts,
	session: SessionEvidence,
): boolean {
	if (repository.activity.sessionIds.includes(session.sessionId)) return true;
	const root = repository.root;
	if (root) {
		if (pathContains(root, session.cwd)) return true;
		if (session.referencedPaths.some((path) => pathContains(root, path))) return true;
	}
	const github = repository.github;
	return github
		? session.githubRepositories.some(
				(slug) => slug.toLowerCase() === github.toLowerCase(),
			)
		: false;
}

function repositoriesForSession(
	session: SessionEvidence,
	repositories: RepositoryFacts[],
): string[] {
	return repositories
		.flatMap((repository) =>
			repositoryMatchesSession(repository, session) ? [repository.key] : [],
		)
		.sort((a, b) => a.localeCompare(b));
}

export function buildWorkspaceFacts(
	sessions: SessionEvidence[],
	repositories: RepositoryFacts[],
): WorkspaceFacts[] {
	const grouped = new Map<string, WorkspaceFacts>();
	for (const session of sessions) {
		let workspace = grouped.get(session.cwd);
		if (!workspace) {
			workspace = {
				cwd: session.cwd,
				sessionCount: 0,
				isGitRepository: repositories.some(
					(repository) =>
						repository.root !== undefined &&
						pathContains(repository.root, session.cwd),
				),
				repositories: [],
				localRepositories: [],
				localRepositoryCount: 0,
				operationCounts: emptyOperationCounts(),
				workspaceRootErrors: 0,
			};
			grouped.set(session.cwd, workspace);
		}
		workspace.sessionCount++;
		workspace.workspaceRootErrors += session.workspaceRootErrors;
		mergeOperationCounts(workspace.operationCounts, session.operationCounts);
		workspace.repositories.push(...repositoriesForSession(session, repositories));
	}
	for (const workspace of grouped.values()) {
		workspace.repositories = [...new Set(workspace.repositories)].sort((a, b) =>
			a.localeCompare(b),
		);
		workspace.localRepositories = workspace.repositories.filter((key) =>
			repositories.some((repository) => repository.key === key && repository.root),
		);
		workspace.localRepositoryCount = workspace.localRepositories.length;
	}
	return [...grouped.values()].sort(
		(a, b) => b.sessionCount - a.sessionCount || a.cwd.localeCompare(b.cwd),
	);
}

