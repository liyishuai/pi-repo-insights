// SPDX-License-Identifier: MPL-2.0

import type {
	PromptClassification,
	PromptKind,
	RepoInsightsReport,
} from "./types.ts";

const KIND_ORDER: PromptKind[] = [
	"request",
	"steering",
	"response",
	"other",
	"unclear",
];

function inline(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ");
}

function label(value: string): string {
	return value
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function markdownFence(value: string): string {
	const longestRun = Math.max(
		0,
		...(value.match(/`+/g) ?? []).map((match) => match.length),
	);
	return "`".repeat(Math.max(4, longestRun + 1));
}

function kindCounts(
	classifications: PromptClassification[],
): Record<PromptKind, number> {
	return {
		request: classifications.filter((item) => item.kind === "request").length,
		steering: classifications.filter((item) => item.kind === "steering").length,
		response: classifications.filter((item) => item.kind === "response").length,
		other: classifications.filter((item) => item.kind === "other").length,
		unclear: classifications.filter((item) => item.kind === "unclear").length,
	};
}

export function renderMarkdown(report: RepoInsightsReport): string {
	const lines: string[] = [];
	const counts = kindCounts(report.classifications);
	lines.push("# Pi Repository Insights", "");
	lines.push(`Generated: ${report.generatedAt}`);
	lines.push(`Model catalog: \`${report.options.modelCatalog ?? "all"}\``);
	lines.push(`Classifier model: \`${report.classifierModel}\``);
	lines.push(`Repository analysis model: \`${report.analysisModel}\``);
	lines.push(
		`Sessions: ${report.sessions.analyzed} analyzed / ${report.sessions.discovered} discovered (${report.sessions.skipped} skipped)`,
	);
	lines.push(
		`Prompts: ${report.sessions.promptsClassified} classified / ${report.sessions.promptsAnalyzed} submitted`,
	);
	if (report.sessions.promptInputTruncated) {
		lines.push(
			"Input cap reached: yes; the report does not claim complete prompt coverage.",
		);
	}
	lines.push(
		"",
		"> Classification uses only chronological user prompts. Bounded repository inventories ground issue drafts but do not classify user behavior.",
		"> Prompt wording and detailed steering entries are not written to this report. Issue descriptions are model-generated synthesis.",
		"",
	);

	lines.push("## Classification summary", "");
	lines.push("| Kind | Prompts | Meaning |", "|---|---:|---|");
	const meanings = {
		request: "A new or additive desired outcome, order, preference, or question",
		steering:
			"A correction, rejection, redirection, or constraint prompted by current agent behavior",
		response:
			"Information, approval, or a decision supplied in response to the agent",
		other:
			"Acknowledgement, status-only content, or content outside the primary classes",
		unclear: "The classifier did not return a usable class",
	} satisfies Record<PromptKind, string>;
	for (const kind of KIND_ORDER) {
		lines.push(`| ${label(kind)} | ${counts[kind]} | ${meanings[kind]} |`);
	}
	lines.push("");

	lines.push("## Draft GitHub issues", "");
	for (const issue of report.issues) {
		const fence = markdownFence(issue.body);
		lines.push(
			`### \`${inline(issue.repository)}\``,
			"",
			"#### Issue title",
			"",
			inline(issue.title),
			"",
			"#### Issue body",
			"",
			`${fence}markdown`,
			issue.body,
			fence,
			"",
		);
	}
	if (report.issues.length === 0) {
		lines.push(
			"No repository issue draft was produced from the available steering and inventory evidence.",
			"",
		);
	}

	lines.push("## Methodology and privacy", "");
	for (const item of report.methodology) lines.push(`- ${item}`);
	lines.push("");
	return `${lines.join("\n")}\n`;
}
