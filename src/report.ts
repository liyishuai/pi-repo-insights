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

function repositories(classification: PromptClassification): string {
	return classification.repositories.length
		? classification.repositories
				.map((repository) => `\`${repository}\``)
				.join(", ")
		: "Unresolved";
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
	lines.push(`Classifier model: \`${report.classifierModel}\``);
	lines.push(`Analysis model: \`${report.analysisModel}\``);
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
		"> Classification uses only chronological user prompts. Repository and tool-path facts are attribution only, not behavioral evidence.",
		"> Prompt wording is never written to this report; all descriptions below are model-generated paraphrases.",
		"",
	);

	lines.push("## Classification summary", "");
	lines.push("| Kind | Prompts | Meaning |", "|---|---:|---|");
	const meanings: Record<PromptKind, string> = {
		request: "A new or additive desired outcome, order, preference, or question",
		steering:
			"A correction, rejection, redirection, or constraint prompted by current agent behavior",
		response:
			"Information, approval, or a decision supplied in response to the agent",
		other:
			"Acknowledgement, status-only content, or content outside the primary classes",
		unclear: "The classifier did not return a usable class",
	};
	for (const kind of KIND_ORDER) {
		lines.push(`| ${label(kind)} | ${counts[kind]} | ${meanings[kind]} |`);
	}
	lines.push("");

	lines.push("### By session", "");
	lines.push(
		"| Session | Requests | Steering | Responses | Other | Unclear |",
		"|---|---:|---:|---:|---:|---:|",
	);
	const sessionIds = [
		...new Set(
			report.classifications.map((classification) => classification.sessionId),
		),
	];
	for (const sessionId of sessionIds) {
		const sessionCounts = kindCounts(
			report.classifications.filter(
				(classification) => classification.sessionId === sessionId,
			),
		);
		lines.push(
			`| \`${sessionId.slice(0, 8)}\` | ${sessionCounts.request} | ${sessionCounts.steering} | ${sessionCounts.response} | ${sessionCounts.other} | ${sessionCounts.unclear} |`,
		);
	}
	if (sessionIds.length === 0)
		lines.push("| _No prompts_ | 0 | 0 | 0 | 0 | 0 |");
	lines.push("");

	lines.push("## Repository attribution", "");
	lines.push(
		"| Repository | Sessions | Local checkouts | Canonical root |",
		"|---|---:|---:|---|",
	);
	for (const repository of report.repositories) {
		lines.push(
			`| \`${inline(repository.key)}\` | ${repository.sessionIds.length} | ${repository.checkoutCount} | ${repository.root ? `\`${inline(repository.root)}\`` : "Remote reference only"} |`,
		);
	}
	if (report.repositories.length === 0) {
		lines.push("| _No repository attribution resolved_ | 0 | 0 | — |");
	}
	lines.push("");

	lines.push("## Steering detected", "");
	const steering = report.classifications.filter(
		(classification) => classification.kind === "steering",
	);
	for (const classification of steering) {
		lines.push(
			`### ${label(classification.steeringCategory ?? "course_correction")} — session \`${classification.sessionId.slice(0, 8)}\`, prompt ${classification.promptIndex}`,
			"",
			`- **Repositories:** ${repositories(classification)}`,
			`- **Confidence:** ${classification.confidence}`,
			`- **What the user signaled:** ${inline(classification.paraphrase)}`,
			`- **Expected adjustment:** ${inline(classification.expectedBehavior ?? "Follow the user's correction.")}`,
			"",
		);
	}
	if (steering.length === 0)
		lines.push("No steering prompts were classified.", "");

	lines.push("## Repeated steering themes", "");
	for (const theme of report.themes) {
		lines.push(
			`### ${inline(theme.title)}`,
			"",
			`- **Prompt-derived pattern:** ${inline(theme.summary)}`,
			`- **Steering prompts:** ${theme.promptIds.length}`,
			`- **Repositories:** ${theme.repositories.length ? theme.repositories.map((repository) => `\`${inline(repository)}\``).join(", ") : "Unresolved"}`,
			`- **Repository-level action:** ${theme.repositoryAction ? inline(theme.repositoryAction) : "None inferred. Treat this as agent-behavior feedback rather than inventing a repository change."}`,
			"",
		);
	}
	if (report.themes.length === 0)
		lines.push("No repeated steering themes were produced.", "");

	lines.push("## Methodology and privacy", "");
	for (const item of report.methodology) lines.push(`- ${item}`);
	lines.push("");
	return `${lines.join("\n")}\n`;
}
