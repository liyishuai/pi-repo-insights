// SPDX-License-Identifier: MPL-2.0

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

type CommandOptions = {
	sinceDays: number;
	maxSessions: number;
	outputDirectory: string;
};

export type ParsedCommand =
	| { kind: "run"; options: CommandOptions }
	| { kind: "help" }
	| { kind: "error"; message: string };

export const HELP_TEXT = `Usage: /repo-insights [options]

Options:
  --since <N>d          Analyze sessions modified in the last N days
  --max-sessions <N>    Bound session loading (default: 200, maximum: 2000)
  --output <directory>  Write report.md and report.json here
  -h, --help            Show this help

The command is local and deterministic. It does not call a model or the GitHub API.`;

function tokenize(args: string): string[] {
	return (args.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? []).map(
		(token) => {
			const quoted =
				(token.startsWith('"') && token.endsWith('"')) ||
				(token.startsWith("'") && token.endsWith("'"));
			return quoted ? token.slice(1, -1) : token;
		},
	);
}

function resolveOutputDirectory(value: string, cwd: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function parseCommandOptions(
	args: string,
	cwd: string,
	defaultOutputDirectory = resolve(homedir(), ".pi", "agent", "repo-insights"),
): ParsedCommand {
	const tokens = tokenize(args);
	const options: CommandOptions = {
		sinceDays: 0,
		maxSessions: 200,
		outputDirectory: defaultOutputDirectory,
	};

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "-h" || token === "--help") return { kind: "help" };
		if (token === "--since") {
			const value = tokens[++index];
			const match = value?.match(/^(\d+)d$/);
			if (!match?.[1] || Number(match[1]) < 1) {
				return { kind: "error", message: "--since must use a positive day value such as 30d" };
			}
			options.sinceDays = Number(match[1]);
			continue;
		}
		if (token === "--max-sessions") {
			const value = tokens[++index];
			const count = value ? Number(value) : Number.NaN;
			if (!Number.isInteger(count) || count < 1 || count > 2_000) {
				return { kind: "error", message: "--max-sessions must be an integer from 1 to 2000" };
			}
			options.maxSessions = count;
			continue;
		}
		if (token === "--output") {
			const value = tokens[++index];
			if (!value) return { kind: "error", message: "--output requires a directory" };
			options.outputDirectory = resolveOutputDirectory(value, cwd);
			continue;
		}
		return { kind: "error", message: `Unknown option: ${token}` };
	}

	return { kind: "run", options };
}
