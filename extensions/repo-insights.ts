// SPDX-License-Identifier: MPL-2.0

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRepositoryHistory, type AnalysisProgress } from "../src/analyze.ts";
import { HELP_TEXT, parseCommandOptions } from "../src/options.ts";
import { renderMarkdown } from "../src/report.ts";

function progressLines(progress: AnalysisProgress): string[] {
	let label = "Building report";
	if (progress.phase === "sessions") label = "Reading session evidence";
	if (progress.phase === "repositories") label = "Inspecting repositories";
	return [
		"",
		"  Pi Repository Insights",
		"  ─────────────────────────",
		`  ${label}: ${progress.completed}/${progress.total}`,
	];
}

export default function repoInsightsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("repo-insights", {
		description: "Analyze Pi sessions for repository-level engineering opportunities",
		handler: async (args, ctx) => {
			const parsed = parseCommandOptions(args ?? "", ctx.cwd);
			if (parsed.kind === "help") {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			if (parsed.kind === "error") {
				ctx.ui.notify(`${parsed.message}\n\n${HELP_TEXT}`, "error");
				return;
			}

			ctx.ui.setStatus("repo-insights", "Analyzing repositories…");
			ctx.ui.setWidget("repo-insights", progressLines({
				phase: "sessions",
				completed: 0,
				total: 1,
			}));

			try {
				const sessionInfos = await SessionManager.listAll((loaded, total) => {
					ctx.ui.setWidget(
						"repo-insights",
						progressLines({ phase: "sessions", completed: loaded, total }),
					);
				});
				const sources = sessionInfos.map((info) => ({
					id: info.id,
					path: info.path,
					cwd: info.cwd,
					created: info.created,
					modified: info.modified,
				}));
				const report = await analyzeRepositoryHistory(
					sources,
					async (source) => SessionManager.open(source.path).getEntries(),
					{
						sinceDays: parsed.options.sinceDays,
						maxSessions: parsed.options.maxSessions,
						currentSessionId: ctx.sessionManager.getSessionId(),
						onProgress: (progress) => {
							ctx.ui.setWidget("repo-insights", progressLines(progress));
						},
					},
				);

				await mkdir(parsed.options.outputDirectory, { recursive: true });
				const markdownPath = join(parsed.options.outputDirectory, "report.md");
				const jsonPath = join(parsed.options.outputDirectory, "report.json");
				await Promise.all([
					writeFile(markdownPath, renderMarkdown(report), {
						encoding: "utf8",
						mode: 0o600,
					}),
					writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {
						encoding: "utf8",
						mode: 0o600,
					}),
				]);

				ctx.ui.notify(
					`Repository insights written:\n${markdownPath}\n${jsonPath}\n\n${report.repositories.length} repositories, ${report.opportunities.length} evidence-backed opportunities`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Repository insights failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("repo-insights", undefined);
				ctx.ui.setWidget("repo-insights", undefined);
			}
		},
	});
}
