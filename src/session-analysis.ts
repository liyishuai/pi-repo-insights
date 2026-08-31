// SPDX-License-Identifier: MPL-2.0

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	emptyOperationCounts,
	type OperationCounts,
	type SessionEvidence,
	type SessionSource,
} from "./types.ts";

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

const TEST_COMMAND =
	/(?:^|[;&|\s])(?:go\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+test|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest)|cargo\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/i;

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

export function normalizeGitHubRepository(value: string): string | undefined {
	const cleaned = value
		.trim()
		.replace(/^['"(<]+/, "")
		.replace(/[>'"),.;:]+$/, "")
		.replace(/\.git$/, "");
	const match = cleaned.match(
		/^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)$/,
	);
	if (!match) return undefined;
	return `${match[1]}/${match[2]}`;
}

export function extractGitHubRepositories(text: string): string[] {
	const repositories = new Set<string>();
	const patterns = [
		/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
		/https?:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
		/git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
		/(?:--repo|-R)\s+['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g,
	];

	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const candidate = match[2] ? `${match[1]}/${match[2]}` : match[1];
			const normalized = candidate
				? normalizeGitHubRepository(candidate)
				: undefined;
			if (normalized) repositories.add(normalized);
		}
	}

	return [...repositories];
}

function normalizePath(candidate: string, cwd: string): string | undefined {
	let value = candidate.trim().replace(/^['"]|['"]$/g, "");
	value = value.replace(/[),;]+$/, "");
	if (!value || /[*?{}$`]/.test(value) || value.startsWith("http")) {
		return undefined;
	}
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
	else if (!isAbsolute(value)) value = resolve(cwd, value);
	return value;
}

function collectPathArguments(
	value: unknown,
	cwd: string,
	paths: Set<string>,
	key?: string,
): void {
	if (typeof value === "string") {
		if (!key || !PATH_KEYS.has(key)) return;
		const normalized = normalizePath(value, cwd);
		if (normalized) paths.add(normalized);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathArguments(item, cwd, paths, key);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	for (const [childKey, child] of Object.entries(record)) {
		collectPathArguments(child, cwd, paths, childKey);
	}
}

function extractCommandPaths(command: string, cwd: string): string[] {
	const paths = new Set<string>();
	const absolutePattern = /(?:^|[\s'"=(:])((?:\/[^/\s'"|;&,)]+)+)/g;
	for (const match of command.matchAll(absolutePattern)) {
		const normalized = match[1] ? normalizePath(match[1], cwd) : undefined;
		if (normalized) paths.add(normalized);
	}

	const workingDirectoryPatterns = [
		/(?:^|[;&|]\s*)cd\s+(['"]?[^\s;&|]+['"]?)/g,
		/\bgit\s+-C\s+(['"]?[^\s;&|]+['"]?)/g,
	];
	for (const pattern of workingDirectoryPatterns) {
		for (const match of command.matchAll(pattern)) {
			const normalized = match[1] ? normalizePath(match[1], cwd) : undefined;
			if (normalized) paths.add(normalized);
		}
	}
	return [...paths];
}

function classifyCommand(
	command: string,
	counts: OperationCounts,
): void {
	if (/\bgh\s+run\s+(?:view|list|watch)\b/i.test(command)) {
		counts.github_run_observation++;
	}
	if (/\bgh\s+workflow\s+run\b/i.test(command)) {
		counts.github_workflow_dispatch++;
	}
	if (/\bgh\s+pr\s+(?:view|checks|diff|list|status)\b/i.test(command)) {
		counts.github_pr_inspection++;
	}
	if (/\bgh\s+issue\s+edit\b/i.test(command)) {
		counts.github_issue_edit++;
	}
	if (/\bgit(?:\s+-C\s+\S+)?\s+status\b/i.test(command)) {
		counts.git_status++;
	}
	if (/\bgit(?:\s+-C\s+\S+)?\s+diff\b/i.test(command)) {
		counts.git_diff++;
	}
	if (TEST_COMMAND.test(command)) counts.test_execution++;
	if (/\bgit\s+worktree\s+(?:add|remove|prune|list)\b/i.test(command)) {
		counts.worktree_management++;
	}
}

export function mergeOperationCounts(
	target: OperationCounts,
	source: OperationCounts,
): void {
	for (const key of Object.keys(target) as Array<keyof OperationCounts>) {
		target[key] += source[key];
	}
}

export function analyzeSessionEntries(
	entries: unknown[],
	source: SessionSource,
): SessionEvidence {
	const operationCounts = emptyOperationCounts();
	const githubRepositories = new Set<string>();
	const referencedPaths = new Set<string>();
	const modifiedPaths = new Set<string>();
	const seenToolCalls = new Set<string>();
	let toolCalls = 0;
	let toolErrors = 0;
	let workspaceRootErrors = 0;
	let anonymousToolCallIndex = 0;

	for (const rawEntry of entries) {
		const entry = asRecord(rawEntry);
		if (entry?.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;

		if (message.role === "user") {
			for (const repository of extractGitHubRepositories(
				textFromContent(message.content),
			)) {
				githubRepositories.add(repository);
			}
		}

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const rawBlock of message.content) {
				const block = asRecord(rawBlock) as ContentBlock | undefined;
				if (block?.type !== "toolCall" || typeof block.name !== "string") {
					continue;
				}
				const toolCallId =
					typeof block.id === "string"
						? block.id
						: `anonymous-${anonymousToolCallIndex++}`;
				if (seenToolCalls.has(toolCallId)) continue;
				seenToolCalls.add(toolCallId);
				toolCalls++;

				const args = block.arguments ?? {};
				collectPathArguments(args, source.cwd, referencedPaths);
				const serializedArgs = JSON.stringify(args);
				for (const repository of extractGitHubRepositories(serializedArgs)) {
					githubRepositories.add(repository);
				}

				if (block.name === "bash") {
					const command =
						typeof args.command === "string" ? args.command : "";
					classifyCommand(command, operationCounts);
					for (const repository of extractGitHubRepositories(command)) {
						githubRepositories.add(repository);
					}
					for (const candidatePath of extractCommandPaths(
						command,
						source.cwd,
					)) {
						referencedPaths.add(candidatePath);
					}
				}

				if (block.name === "edit" || block.name === "write") {
					const pathValue = args.path ?? args.file_path;
					if (typeof pathValue === "string") {
						const normalized = normalizePath(pathValue, source.cwd);
						if (normalized) modifiedPaths.add(normalized);
					}
				}
			}
		}

		if (message.role === "toolResult" && message.isError === true) {
			toolErrors++;
			const errorText = textFromContent(message.content);
			if (/not a git repository/i.test(errorText)) workspaceRootErrors++;
		}
	}

	return {
		sessionId: source.id,
		sessionPath: source.path,
		cwd: source.cwd,
		startedAt: source.created.toISOString(),
		modifiedAt: source.modified.toISOString(),
		toolCalls,
		toolErrors,
		operationCounts,
		githubRepositories: [...githubRepositories].sort((a, b) => a.localeCompare(b)),
		referencedPaths: [...referencedPaths]
			.slice(0, 2_000)
			.sort((a, b) => a.localeCompare(b)),
		modifiedPaths: [...modifiedPaths]
			.slice(0, 1_000)
			.sort((a, b) => a.localeCompare(b)),
		workspaceRootErrors,
	};
}
