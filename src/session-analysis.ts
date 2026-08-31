// SPDX-License-Identifier: MPL-2.0

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { PromptRecord, SessionEvidence, SessionSource } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

type ContentBlock = {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

const PATH_KEYS = new Set([
	"path",
	"paths",
	"file_path",
	"filePath",
	"cwd",
	"directory",
	"workdir",
	"workingDirectory",
	"root",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object"
		? (value as UnknownRecord)
		: undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			const record = asRecord(block);
			return record?.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}

function normalizePath(value: string, cwd: string): string | undefined {
	const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
	if (
		!trimmed ||
		trimmed.includes("\n") ||
		trimmed.startsWith("-") ||
		trimmed.includes("$") ||
		trimmed.includes("*") ||
		trimmed.includes("{")
	) {
		return undefined;
	}
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

export function normalizeGitHubRepository(value: string): string | undefined {
	const cleaned = value
		.trim()
		.replace(/^git@github\.com:/i, "")
		.replace(/^https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?/i, "")
		.replace(/^ssh:\/\/git@github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/[?#].*$/, "")
		.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length < 2) return undefined;
	const [owner, repository] = parts;
	if (!owner || !repository) return undefined;
	if (
		!/^[A-Za-z0-9_.-]+$/.test(owner) ||
		!/^[A-Za-z0-9_.-]+$/.test(repository)
	) {
		return undefined;
	}
	return `${owner}/${repository}`;
}

export function extractGitHubRepositories(text: string): string[] {
	const repositories = new Set<string>();
	const patterns = [
		/https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
		/https?:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
		/git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/gi,
		/ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/gi,
		/(?:--repo|-R)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const repository = match[1]
				? normalizeGitHubRepository(match[1])
				: undefined;
			if (repository) repositories.add(repository);
		}
	}
	return [...repositories].sort((a, b) => a.localeCompare(b));
}

function collectPathArguments(
	value: unknown,
	cwd: string,
	paths: Set<string>,
	depth = 0,
): void {
	if (depth > 4) return;
	if (Array.isArray(value)) {
		for (const item of value) collectPathArguments(item, cwd, paths, depth + 1);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	for (const [key, nested] of Object.entries(record)) {
		if (PATH_KEYS.has(key)) {
			const values = Array.isArray(nested) ? nested : [nested];
			for (const candidate of values) {
				if (typeof candidate !== "string") continue;
				const path = normalizePath(candidate, cwd);
				if (path) paths.add(path);
			}
		}
		if (typeof nested === "object" && nested !== null) {
			collectPathArguments(nested, cwd, paths, depth + 1);
		}
	}
}

function extractCommandPaths(command: string, cwd: string): string[] {
	const paths = new Set<string>();
	const patterns = [
		/(?:^|[;&|]\s*|\s)cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g,
		/(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g,
		/(?:^|\s)--(?:cwd|repo-dir|work-tree|git-dir)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g,
	];
	for (const pattern of patterns) {
		for (const match of command.matchAll(pattern)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (!value) continue;
			const path = normalizePath(value, cwd);
			if (path) paths.add(path);
		}
	}
	for (const match of command.matchAll(/(?:^|\s)(\/(?:[^\s'";&|])+)/g)) {
		const path = match[1] ? normalizePath(match[1], cwd) : undefined;
		if (path) paths.add(path);
	}
	return [...paths];
}

function promptTimestamp(message: UnknownRecord): string | undefined {
	if (
		typeof message.timestamp === "number" &&
		Number.isFinite(message.timestamp)
	) {
		return new Date(message.timestamp).toISOString();
	}
	if (typeof message.timestamp === "string") {
		const timestamp = new Date(message.timestamp);
		if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
	}
	return undefined;
}

function collectToolAttribution(
	message: UnknownRecord,
	cwd: string,
	seenToolCalls: Set<string>,
	referencedPaths: Set<string>,
	githubRepositories: Set<string>,
	anonymousIndex: { value: number },
): void {
	if (!Array.isArray(message.content)) return;
	for (const rawBlock of message.content) {
		const block = asRecord(rawBlock) as ContentBlock | undefined;
		if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
		const id =
			typeof block.id === "string"
				? block.id
				: `anonymous-${anonymousIndex.value++}`;
		if (seenToolCalls.has(id)) continue;
		seenToolCalls.add(id);
		const args = block.arguments ?? {};
		collectPathArguments(args, cwd, referencedPaths);
		let serialized = "";
		try {
			serialized = JSON.stringify(args);
		} catch {
			// Session arguments should be JSON, but attribution can continue without them.
		}
		for (const repository of extractGitHubRepositories(serialized)) {
			githubRepositories.add(repository);
		}
		if (block.name !== "bash") continue;
		const command = typeof args.command === "string" ? args.command : "";
		for (const repository of extractGitHubRepositories(command)) {
			githubRepositories.add(repository);
		}
		for (const path of extractCommandPaths(command, cwd))
			referencedPaths.add(path);
	}
}

export function analyzeSessionEntries(
	entries: unknown[],
	source: SessionSource,
): SessionEvidence {
	const prompts: PromptRecord[] = [];
	const githubRepositories = new Set<string>();
	const referencedPaths = new Set<string>();
	const seenToolCalls = new Set<string>();
	const anonymousIndex = { value: 0 };

	for (const rawEntry of entries) {
		const entry = asRecord(rawEntry);
		if (entry?.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;
		if (message.role === "user") {
			const text = textFromContent(message.content).trim();
			if (!text) continue;
			const prompt: PromptRecord = { index: prompts.length + 1, text };
			const timestamp = promptTimestamp(message);
			if (timestamp) prompt.timestamp = timestamp;
			prompts.push(prompt);
			for (const repository of extractGitHubRepositories(text)) {
				githubRepositories.add(repository);
			}
			continue;
		}
		if (message.role === "assistant") {
			collectToolAttribution(
				message,
				source.cwd,
				seenToolCalls,
				referencedPaths,
				githubRepositories,
				anonymousIndex,
			);
		}
	}

	return {
		sessionId: source.id,
		sessionPath: source.path,
		cwd: source.cwd,
		startedAt: source.created.toISOString(),
		modifiedAt: source.modified.toISOString(),
		prompts,
		githubRepositories: [...githubRepositories].sort((a, b) =>
			a.localeCompare(b),
		),
		referencedPaths: [...referencedPaths]
			.slice(0, 2_000)
			.sort((a, b) => a.localeCompare(b)),
	};
}
