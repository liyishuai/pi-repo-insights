// SPDX-License-Identifier: MPL-2.0

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	GitHubThreadSummary,
	RepositoryGuidanceFile,
	RepositoryGuidanceResult,
	RepositoryThreadLookup,
} from "./types.ts";

const MAX_RESULTS = 20;
const MAX_BODY_CHARACTERS = 2_500;
const MAX_QUERY_CHARACTERS = 240;
const DEFAULT_GITHUB_API_HOST = "api.github.com";
const MAX_GUIDANCE_FILES = 12;
const MAX_GUIDANCE_FILE_CHARACTERS = 8_000;
const MAX_GUIDANCE_CHARACTERS = 30_000;

type GitHubSearchResponse = {
	items?: Array<{
		number?: number;
		title?: string;
		html_url?: string;
		body?: string | null;
		updated_at?: string;
		pull_request?: unknown;
	}>;
};

function githubSlug(repository: string): string | undefined {
	const normalized = repository
		.trim()
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/^git@github\.com:/i, "")
		.replace(/^github\.com\//i, "")
		.replace(/\.git$/i, "");
	return /^[^/]+\/[^/]+$/.test(normalized) ? normalized : undefined;
}

function cleanSearchTerm(value: string): string {
	return value
		.replace(/["'()]/g, " ")
		.replace(/\b(?:repo|is|state|type|author|assignee|label):\S+/gi, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

function buildSearchQuery(slug: string, searchPhrase: string): string {
	const prefix = `repo:${slug} state:open `;
	const fallback = "repository infrastructure";
	const term = cleanSearchTerm(searchPhrase) || fallback;
	const available = Math.max(1, MAX_QUERY_CHARACTERS - prefix.length - 2);
	return `${prefix}"${term.slice(0, available)}"`;
}

function runGitHubCli(query: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"gh",
			[
				"api",
				"--method",
				"GET",
				"search/issues",
				"-f",
				`q=${query}`,
				"-f",
				`per_page=${MAX_RESULTS}`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, GH_PAGER: "cat" },
				maxBuffer: 2 * 1024 * 1024,
				timeout: 20_000,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

async function runGitHubRest(query: string): Promise<string> {
	const apiBase =
		process.env.GITHUB_API_URL ?? `https://${DEFAULT_GITHUB_API_HOST}`;
	const parameters = new URLSearchParams({
		q: query,
		per_page: String(MAX_RESULTS),
	});
	const url = `${apiBase.replace(/\/$/, "")}/search/issues?${parameters}`;
	const headers = new Headers({
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-repo-insights",
		"X-GitHub-Api-Version": "2022-11-28",
	});
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`GitHub REST returned ${response.status}`);
	}
	return response.text();
}

function parseSearchResponse(text: string): GitHubThreadSummary[] {
	let parsed: GitHubSearchResponse;
	try {
		parsed = JSON.parse(text) as GitHubSearchResponse;
	} catch {
		return [];
	}
	return (Array.isArray(parsed.items) ? parsed.items : [])
		.flatMap((item) => {
			if (
				typeof item.number !== "number" ||
				!item.title ||
				!item.html_url
			) {
				return [];
			}
			const kind = item.pull_request ? "pull_request" : "issue";
			const thread: GitHubThreadSummary = {
				ref: `${kind === "pull_request" ? "PR" : "ISSUE"}-${item.number}`,
				kind,
				number: item.number,
				title: item.title.slice(0, 300),
				url: item.html_url,
				bodyExcerpt: String(item.body ?? "").slice(0, MAX_BODY_CHARACTERS),
			};
			if (item.updated_at) thread.updatedAt = item.updated_at;
			return [thread];
		})
		.slice(0, MAX_RESULTS);
}

function errorText(error: Error | string): string {
	return (error instanceof Error ? error.message : error)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

export async function searchOpenGitHubThreads(
	repository: string,
	searchPhrase: string,
): Promise<RepositoryThreadLookup> {
	const slug = githubSlug(repository);
	if (!slug) {
		return {
			repository,
			status: "unsupported",
			threads: [],
			error: "Repository is not attributed to github.com.",
		};
	}
	const query = buildSearchQuery(slug, searchPhrase);
	try {
		return {
			repository,
			status: "success",
			source: "gh",
			query,
			threads: parseSearchResponse(await runGitHubCli(query)),
		};
	} catch (cliError) {
		try {
			return {
				repository,
				status: "success",
				source: "rest",
				query,
				threads: parseSearchResponse(await runGitHubRest(query)),
			};
		} catch (restError) {
			return {
				repository,
				status: "failed",
				query,
				threads: [],
				error: `gh: ${errorText(cliError instanceof Error ? cliError : String(cliError))}; REST: ${errorText(restError instanceof Error ? restError : String(restError))}`,
			};
		}
	}
}

const GUIDANCE_PATH = /^(?:(?:\.github\/|docs\/)?CONTRIBUTING(?:\.(?:md|rst|txt))?|\.github\/ISSUE_TEMPLATE\.md|\.github\/ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml))$/i;

function guidancePathPriority(path: string): number {
	if (/CONTRIBUTING(?:\.(?:md|rst|txt))?$/i.test(path)) return 0;
	if (/ISSUE_TEMPLATE\.md$/i.test(path)) return 1;
	if (/ISSUE_TEMPLATE\/config\.ya?ml$/i.test(path)) return 3;
	return 2;
}

function compareGuidancePaths(a: string, b: string): number {
	return guidancePathPriority(a) - guidancePathPriority(b) || a.localeCompare(b);
}

type ProcessError = Error & { code?: string; stderr?: string };

function isMissingPath(error: Error): boolean {
	// SAFETY: Node filesystem errors extend Error and may carry a string code.
	const filesystemError = error as ProcessError;
	return ["ENOENT", "ENOTDIR"].includes(filesystemError.code ?? "");
}

async function optionalDirectoryEntries(directory: string): Promise<Dirent[]> {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && isMissingPath(error)) return [];
		throw error;
	}
}

async function localGuidancePaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isFile() && GUIDANCE_PATH.test(entry.name)) paths.push(entry.name);
	}
	for (const directory of [".github", "docs"]) {
		for (const entry of await optionalDirectoryEntries(join(root, directory))) {
			const path = `${directory}/${entry.name}`;
			if (entry.isFile() && GUIDANCE_PATH.test(path)) paths.push(path);
		}
	}
	for (const entry of await optionalDirectoryEntries(
		join(root, ".github/ISSUE_TEMPLATE"),
	)) {
		const path = `.github/ISSUE_TEMPLATE/${entry.name}`;
		if (entry.isFile() && GUIDANCE_PATH.test(path)) paths.push(path);
	}
	return [...new Set(paths)].sort(compareGuidancePaths);
}

async function readLocalGuidance(
	repository: string,
	root: string,
): Promise<RepositoryGuidanceResult> {
	const paths = await localGuidancePaths(root);
	const files: RepositoryGuidanceFile[] = [];
	let characters = 0;
	for (const path of paths.slice(0, MAX_GUIDANCE_FILES)) {
		if (characters >= MAX_GUIDANCE_CHARACTERS) break;
		try {
			const content = (await readFile(join(root, path), "utf8")).slice(
				0,
				Math.min(
					MAX_GUIDANCE_FILE_CHARACTERS,
					MAX_GUIDANCE_CHARACTERS - characters,
				),
			);
			files.push({ path, content });
			characters += content.length;
		} catch (error) {
			throw new Error(`Could not read repository guidance file ${path}`, {
				cause: error,
			});
		}
	}
	return { repository, status: "success", source: "local", files };
}

function runGitHubApi(endpoint: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"gh",
			["api", endpoint],
			{
				encoding: "utf8",
				env: { ...process.env, GH_PAGER: "cat" },
				maxBuffer: 2 * 1024 * 1024,
				timeout: 20_000,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

function githubApiHeaders(requireAuth = false): Headers {
	const headers = new Headers({
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-repo-insights",
		"X-GitHub-Api-Version": "2022-11-28",
	});
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (requireAuth && !token) throw new Error("No GH_TOKEN or GITHUB_TOKEN is available");
	return headers;
}

async function runGitHubRestEndpoint(endpoint: string): Promise<string> {
	const apiBase =
		process.env.GITHUB_API_URL ?? `https://${DEFAULT_GITHUB_API_HOST}`;
	const response = await fetch(`${apiBase.replace(/\/$/, "")}/${endpoint}`, {
		headers: githubApiHeaders(),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`GitHub REST returned ${response.status}`);
	return response.text();
}

type GitHubContentEntry = {
	path?: string;
	type?: "file" | "dir" | string;
};

type GitHubContentResponse = {
	content?: string;
	encoding?: string;
};

function parseJson<T>(text: string): T {
	try {
		// SAFETY: Every caller validates the fields it consumes from this GitHub response.
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error("GitHub returned invalid JSON", { cause: error });
	}
}

function contentEntries(text: string): GitHubContentEntry[] {
	const parsed = parseJson<GitHubContentEntry[] | GitHubContentEntry>(text);
	return Array.isArray(parsed) ? parsed : [parsed];
}

function decodeGitHubContent(text: string): string {
	const response = parseJson<GitHubContentResponse>(text);
	if (response.encoding !== "base64" || !response.content) return "";
	return Buffer.from(response.content.replace(/\s+/g, ""), "base64").toString(
		"utf8",
	);
}

async function readRemoteGuidance(
	repository: string,
	slug: string,
): Promise<RepositoryGuidanceResult> {
	let source: "gh" | "rest";
	const rootEndpoint = `repos/${slug}/contents`;
	let rootText: string;
	try {
		rootText = await runGitHubApi(rootEndpoint);
		source = "gh";
	} catch {
		rootText = await runGitHubRestEndpoint(rootEndpoint);
		source = "rest";
	}
	const readEndpoint = (endpoint: string) =>
		source === "gh"
			? runGitHubApi(endpoint)
			: runGitHubRestEndpoint(endpoint);
	const entries = contentEntries(rootText);
	const rootDirectories = new Set(
		entries.flatMap((entry) =>
			entry.type === "dir" && entry.path ? [entry.path] : [],
		),
	);
	if (rootDirectories.has(".github")) {
		const githubEntries = contentEntries(
			await readEndpoint(`repos/${slug}/contents/.github`),
		);
		entries.push(...githubEntries);
		if (
			githubEntries.some(
				(entry) =>
					entry.type === "dir" && entry.path === ".github/ISSUE_TEMPLATE",
			)
		) {
			entries.push(
				...contentEntries(
					await readEndpoint(`repos/${slug}/contents/.github/ISSUE_TEMPLATE`),
				),
			);
		}
	}
	if (rootDirectories.has("docs")) {
		entries.push(
			...contentEntries(await readEndpoint(`repos/${slug}/contents/docs`)),
		);
	}
	const paths = [
		...new Set(
			entries.flatMap((entry) =>
				entry.type === "file" && entry.path && GUIDANCE_PATH.test(entry.path)
					? [entry.path]
					: [],
			),
		),
	]
		.sort(compareGuidancePaths)
		.slice(0, MAX_GUIDANCE_FILES);
	const files: RepositoryGuidanceFile[] = [];
	let characters = 0;
	for (const path of paths) {
		if (characters >= MAX_GUIDANCE_CHARACTERS) break;
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		const text = await readEndpoint(`repos/${slug}/contents/${encodedPath}`);
		const content = decodeGitHubContent(text).slice(
			0,
			Math.min(
				MAX_GUIDANCE_FILE_CHARACTERS,
				MAX_GUIDANCE_CHARACTERS - characters,
			),
		);
		files.push({ path, content });
		characters += content.length;
	}
	return { repository, status: "success", source, files };
}

export async function inspectRepositoryGuidance(
	repository: string,
	root?: string,
): Promise<RepositoryGuidanceResult> {
	if (root) {
		try {
			return await readLocalGuidance(repository, root);
		} catch {
			// Fall back to GitHub for an unreadable checkout.
		}
	}
	const slug = githubSlug(repository);
	if (!slug) {
		return {
			repository,
			status: "unsupported",
			files: [],
			error: "Repository is not attributed to github.com.",
		};
	}
	try {
		return await readRemoteGuidance(repository, slug);
	} catch (error) {
		return {
			repository,
			status: "failed",
			files: [],
			error: errorText(error instanceof Error ? error : String(error)),
		};
	}
}

export type IssueSubmissionResult = {
	status: "success" | "failed";
	url?: string;
	error?: string;
};

function runGitHubIssueCreate(
	slug: string,
	title: string,
	body: string,
	labels: string[],
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = [
			"issue",
			"create",
			"--repo",
			slug,
			"--title",
			title,
			"--body",
			body,
		];
		for (const label of labels) args.push("--label", label);
		execFile(
			"gh",
			args,
			{
				encoding: "utf8",
				env: { ...process.env, GH_PAGER: "cat" },
				maxBuffer: 1024 * 1024,
				timeout: 30_000,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout.trim());
			},
		);
	});
}

async function createIssueWithRest(
	slug: string,
	title: string,
	body: string,
	labels: string[],
): Promise<string> {
	const apiBase =
		process.env.GITHUB_API_URL ?? `https://${DEFAULT_GITHUB_API_HOST}`;
	const response = await fetch(
		`${apiBase.replace(/\/$/, "")}/repos/${slug}/issues`,
		{
			method: "POST",
			headers: githubApiHeaders(true),
			body: JSON.stringify({ title, body, labels }),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) throw new Error(`GitHub REST returned ${response.status}`);
	const created = parseJson<{ html_url?: string }>(await response.text());
	if (!created.html_url) throw new Error("GitHub did not return an issue URL");
	return created.html_url;
}

function shouldUseRestWriteFallback(error: Error): boolean {
	// SAFETY: Node child-process errors extend Error and may include code and stderr.
	const processError = error as ProcessError;
	if (processError.code === "ENOENT") return true;
	const details = `${processError.message}\n${processError.stderr ?? ""}`;
	return /(?:gh auth login|not logged (?:in|into)|authentication required)/i.test(
		details,
	);
}

export async function submitGitHubIssue(
	repository: string,
	title: string,
	body: string,
	labels: string[] = [],
): Promise<IssueSubmissionResult> {
	const slug = githubSlug(repository);
	if (!slug) {
		return { status: "failed", error: "Repository is not on github.com." };
	}
	try {
		return {
			status: "success",
			url: await runGitHubIssueCreate(slug, title, body, labels),
		};
	} catch (cliError) {
		if (
			!(cliError instanceof Error) ||
			!shouldUseRestWriteFallback(cliError)
		) {
			return {
				status: "failed",
				error: `gh: ${errorText(cliError instanceof Error ? cliError : String(cliError))}; REST fallback was not attempted after an ambiguous write failure.`,
			};
		}
		try {
			return {
				status: "success",
				url: await createIssueWithRest(slug, title, body, labels),
			};
		} catch (restError) {
			return {
				status: "failed",
				error: `gh: ${errorText(cliError instanceof Error ? cliError : String(cliError))}; REST: ${errorText(restError instanceof Error ? restError : String(restError))}`,
			};
		}
	}
}
