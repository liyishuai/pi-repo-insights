// SPDX-License-Identifier: MPL-2.0

import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeGitHubRepository } from "./session-analysis.ts";
import type { RepositoryAttribution, SessionEvidence } from "./types.ts";

const execFileAsync = promisify(execFile);
const MAX_GIT_CANDIDATES = 600;
const MAX_DIRECT_CHILDREN = 200;

type LocalRepository = {
	root: string;
	remote?: string;
	github?: string;
};

export type RepositoryResolution = {
	repositories: RepositoryAttribution[];
	repositoryKeysBySession: Map<string, string[]>;
};

function pathContains(root: string, candidate: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(candidate);
	return (
		resolvedCandidate === resolvedRoot ||
		resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
	);
}

async function nearestExistingDirectory(
	candidate: string,
): Promise<string | undefined> {
	let current = resolve(candidate);
	while (true) {
		try {
			const details = await stat(current);
			return details.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

async function gitOutput(
	cwd: string,
	args: string[],
): Promise<string | undefined> {
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
		});
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function gitRootForPath(candidate: string): Promise<string | undefined> {
	const directory = await nearestExistingDirectory(candidate);
	if (!directory) return undefined;
	const root = await gitOutput(directory, ["rev-parse", "--show-toplevel"]);
	return root ? resolve(root) : undefined;
}

export function parseGitHubRemote(remote: string): string | undefined {
	return normalizeGitHubRepository(remote);
}

async function resolveLocalRepository(root: string): Promise<LocalRepository> {
	const remote = await gitOutput(root, ["remote", "get-url", "origin"]);
	const github = remote ? parseGitHubRemote(remote) : undefined;
	return { root, remote, github };
}

async function directGitChildren(cwd: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(cwd, { withFileTypes: true });
	} catch {
		return [];
	}
	const children: string[] = [];
	for (const entry of entries.slice(0, MAX_DIRECT_CHILDREN)) {
		if (!entry.isDirectory() || entry.name === ".git") continue;
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

function candidatePaths(sessions: SessionEvidence[]): string[] {
	const paths = new Set<string>();
	for (const session of sessions) paths.add(resolve(session.cwd));
	for (const session of sessions) {
		for (const path of session.referencedPaths) paths.add(resolve(path));
	}
	return [...paths];
}

async function discoverLocalRepositories(
	sessions: SessionEvidence[],
): Promise<LocalRepository[]> {
	const workspaceChildren: string[] = [];
	for (const cwd of new Set(sessions.map((session) => session.cwd))) {
		workspaceChildren.push(...(await directGitChildren(cwd)));
	}
	const candidates = [
		...new Set([...workspaceChildren, ...candidatePaths(sessions)]),
	];
	const roots = new Set<string>();
	for (const candidate of candidates.slice(0, MAX_GIT_CANDIDATES)) {
		if ([...roots].some((root) => pathContains(root, candidate))) continue;
		const root = await gitRootForPath(candidate);
		if (root) roots.add(root);
	}
	return Promise.all(
		[...roots].sort((a, b) => a.localeCompare(b)).map(resolveLocalRepository),
	);
}

function sessionMatchesRepository(
	session: SessionEvidence,
	repository: LocalRepository,
): boolean {
	if (pathContains(repository.root, session.cwd)) return true;
	if (
		session.referencedPaths.some((path) => pathContains(repository.root, path))
	) {
		return true;
	}
	const github = repository.github?.toLowerCase();
	return github
		? session.githubRepositories.some((slug) => slug.toLowerCase() === github)
		: false;
}

function temporaryRoot(root: string): boolean {
	return [
		tmpdir(),
		"/tmp",
		"/private/tmp",
		"/var/folders",
		"/private/var/folders",
	]
		.map((path) => resolve(path))
		.some((path) => pathContains(path, root));
}

function preferredRoot(roots: string[]): string | undefined {
	return [...roots].sort((a, b) => {
		const durableDifference = Number(temporaryRoot(a)) - Number(temporaryRoot(b));
		if (durableDifference) return durableDifference;
		const worktreeDifference =
			Number(a.includes(`${sep}.worktrees${sep}`)) -
			Number(b.includes(`${sep}.worktrees${sep}`));
		return worktreeDifference || a.length - b.length || a.localeCompare(b);
	})[0];
}

function repositoryName(
	github: string | undefined,
	root: string | undefined,
): string {
	if (github) {
		const [, name] = github.split("/");
		if (name) return name;
	}
	return root ? basename(root) : "unknown";
}

export async function resolveRepositoryAttribution(
	sessions: SessionEvidence[],
): Promise<RepositoryResolution> {
	const local = await discoverLocalRepositories(sessions);
	const groups = new Map<
		string,
		{ github?: string; roots: string[]; sessionIds: Set<string> }
	>();
	for (const repository of local) {
		const matchingSessions = sessions.filter((session) =>
			sessionMatchesRepository(session, repository),
		);
		if (matchingSessions.length === 0) continue;
		const identity = repository.github?.toLowerCase() ?? repository.root;
		const group = groups.get(identity) ?? {
			github: repository.github,
			roots: [],
			sessionIds: new Set<string>(),
		};
		group.roots.push(repository.root);
		for (const session of matchingSessions)
			group.sessionIds.add(session.sessionId);
		groups.set(identity, group);
	}

	const knownGitHub = new Set(
		[...groups.values()].flatMap((group) =>
			group.github ? [group.github.toLowerCase()] : [],
		),
	);
	for (const github of new Set(
		sessions.flatMap((session) => session.githubRepositories),
	)) {
		if (knownGitHub.has(github.toLowerCase())) continue;
		const sessionIds = new Set(
			sessions.flatMap((session) =>
				session.githubRepositories.some(
					(slug) => slug.toLowerCase() === github.toLowerCase(),
				)
					? [session.sessionId]
					: [],
			),
		);
		groups.set(`remote:${github.toLowerCase()}`, {
			github,
			roots: [],
			sessionIds,
		});
	}

	const repositories: RepositoryAttribution[] = [...groups.values()].map(
		(group) => {
			const root = preferredRoot(group.roots);
			const key = group.github ?? root ?? "unknown";
			return {
				key,
				name: repositoryName(group.github, root),
				...(root ? { root } : {}),
				...(group.github ? { github: group.github } : {}),
				checkoutCount: group.roots.length,
				sessionIds: [...group.sessionIds].sort((a, b) => a.localeCompare(b)),
			};
		},
	);
	repositories.sort(
		(a, b) =>
			b.sessionIds.length - a.sessionIds.length || a.key.localeCompare(b.key),
	);

	const repositoryKeysBySession = new Map<string, string[]>();
	for (const session of sessions) {
		repositoryKeysBySession.set(
			session.sessionId,
			repositories
				.flatMap((repository) =>
					repository.sessionIds.includes(session.sessionId)
						? [repository.key]
						: [],
				)
				.sort((a, b) => a.localeCompare(b)),
		);
	}
	return { repositories, repositoryKeysBySession };
}
