// SPDX-License-Identifier: MPL-2.0

import type {
	PromptClassification,
	PromptKind,
	SessionEvidence,
	SteeringCategory,
	SteeringTheme,
} from "./types.ts";

const MAX_PROMPTS = 500;
const MAX_TOTAL_PROMPT_CHARACTERS = 120_000;
const MAX_SESSION_PROMPTS = 150;
const MAX_SESSION_CHARACTERS = 30_000;
const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_BATCH_PROMPTS = 160;
const MAX_BATCH_CHARACTERS = 40_000;
const EXACT_EXCERPT_WORDS = 8;

const PROMPT_KINDS = new Set<PromptKind>([
	"request",
	"steering",
	"response",
	"other",
	"unclear",
]);
const STEERING_CATEGORIES = new Set<SteeringCategory>([
	"course_correction",
	"scope_reassertion",
	"frustration",
	"missed_requirement",
	"unwanted_action",
	"premature_completion",
	"evidence_challenge",
]);

type PromptItem = {
	ref: string;
	sessionId: string;
	promptIndex: number;
	text: string;
	repositories: string[];
};

export type ClassificationBatch = {
	prompt: string;
	items: PromptItem[];
};

export type ClassificationPlan = {
	batches: ClassificationBatch[];
	items: PromptItem[];
	promptCount: number;
	promptCharacters: number;
	truncated: boolean;
};

type RawClassification = {
	prompt_ref?: string;
	kind?: string;
	paraphrase?: string | null;
	confidence?: string;
	steering_category?: string | null;
	expected_behavior?: string | null;
};

type RawTheme = {
	title?: string | null;
	classification_refs?: string[];
	summary?: string | null;
	repository_action?: string | null;
};

type RawModelResponse = {
	classifications?: RawClassification[];
	themes?: RawTheme[];
};

function boundedText(
	value: string | null | undefined,
	fallback: string,
	maxLength: number,
): string {
	const compact = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return compact ? compact.slice(0, maxLength) : fallback;
}

function words(value: string): string[] {
	return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function containsExactExcerpt(candidate: string, source: string): boolean {
	const sourceWords = words(source);
	const candidateWords = words(candidate);
	if (
		sourceWords.length < EXACT_EXCERPT_WORDS ||
		candidateWords.length < EXACT_EXCERPT_WORDS
	) {
		return false;
	}
	const sourcePhrases = new Set<string>();
	for (
		let index = 0;
		index <= sourceWords.length - EXACT_EXCERPT_WORDS;
		index++
	) {
		sourcePhrases.add(
			sourceWords.slice(index, index + EXACT_EXCERPT_WORDS).join(" "),
		);
	}
	for (
		let index = 0;
		index <= candidateWords.length - EXACT_EXCERPT_WORDS;
		index++
	) {
		if (
			sourcePhrases.has(
				candidateWords.slice(index, index + EXACT_EXCERPT_WORDS).join(" "),
			)
		) {
			return true;
		}
	}
	return false;
}

function safeParaphrase(kind: PromptKind): string {
	switch (kind) {
		case "request":
			return "The user introduced a task or described a desired outcome.";
		case "steering":
			return "The user redirected or corrected the agent's current approach.";
		case "response":
			return "The user supplied information or a decision requested by the agent.";
		case "other":
			return "The prompt did not clearly represent a task request or a correction.";
		default:
			return "The classifier did not return a usable classification for this prompt.";
	}
}

function selectSessionItems(
	session: SessionEvidence,
	sessionAlias: string,
	repositories: string[],
): { items: PromptItem[]; truncated: boolean } {
	let truncated = session.prompts.length > MAX_SESSION_PROMPTS;
	const firstPrompt = session.prompts[0];
	let prompts =
		session.prompts.length > MAX_SESSION_PROMPTS && firstPrompt
			? [firstPrompt, ...session.prompts.slice(-(MAX_SESSION_PROMPTS - 1))]
			: [...session.prompts];
	prompts = prompts.map((prompt) => ({
		...prompt,
		text: prompt.text.slice(0, MAX_PROMPT_CHARACTERS),
	}));
	if (
		prompts.some((prompt) => {
			const sourcePrompt = session.prompts[prompt.index - 1];
			return sourcePrompt ? prompt.text.length < sourcePrompt.text.length : false;
		})
	) {
		truncated = true;
	}
	if (
		prompts.reduce((total, prompt) => total + prompt.text.length, 0) >
		MAX_SESSION_CHARACTERS
	) {
		truncated = true;
		const first = prompts[0];
		const selected = first ? [first] : [];
		let used = first?.text.length ?? 0;
		for (let index = prompts.length - 1; index >= 1; index--) {
			const prompt = prompts[index];
			if (!prompt || used + prompt.text.length > MAX_SESSION_CHARACTERS) continue;
			selected.push(prompt);
			used += prompt.text.length;
		}
		prompts = selected.sort((a, b) => a.index - b.index);
	}
	return {
		items: prompts.map((prompt) => ({
			ref: `${sessionAlias}:P${String(prompt.index).padStart(3, "0")}`,
			sessionId: session.sessionId,
			promptIndex: prompt.index,
			text: prompt.text,
			repositories,
		})),
		truncated,
	};
}

function classificationInstructions(
	data: string,
	skillInstructions: string,
): string {
	return `Apply the packaged skill below in Classification mode. Return only the JSON required by the skill.

BEGIN PACKAGED SKILL
${skillInstructions}
END PACKAGED SKILL

BEGIN PROMPT DATA
${data}
END PROMPT DATA`;
}

function batchPrompt(items: PromptItem[], skillInstructions: string): string {
	const sessions = new Map<string, PromptItem[]>();
	for (const item of items) {
		const group = sessions.get(item.sessionId) ?? [];
		group.push(item);
		sessions.set(item.sessionId, group);
	}
	const sections: string[] = [];
	for (const group of sessions.values()) {
		const first = group[0];
		if (!first) continue;
		sections.push(
			`Session ${first.ref.split(":")[0]}\nRepository attribution: ${first.repositories.join(", ") || "unresolved"}`,
		);
		for (const item of group)
			sections.push(`${item.ref} ${JSON.stringify(item.text)}`);
	}
	return classificationInstructions(sections.join("\n"), skillInstructions);
}

export function buildClassificationPlan(
	sessions: SessionEvidence[],
	repositoryKeysBySession: Map<string, string[]>,
	skillInstructions: string,
): ClassificationPlan {
	const selectedItems: PromptItem[] = [];
	let promptCharacters = 0;
	let truncated = false;
	for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
		const session = sessions[sessionIndex];
		if (!session) continue;
		const alias = `S${String(sessionIndex + 1).padStart(3, "0")}`;
		const selection = selectSessionItems(
			session,
			alias,
			repositoryKeysBySession.get(session.sessionId) ?? [],
		);
		truncated ||= selection.truncated;
		for (const item of selection.items) {
			if (
				selectedItems.length >= MAX_PROMPTS ||
				promptCharacters + item.text.length > MAX_TOTAL_PROMPT_CHARACTERS
			) {
				truncated = true;
				break;
			}
			selectedItems.push(item);
			promptCharacters += item.text.length;
		}
		if (
			selectedItems.length >= MAX_PROMPTS ||
			promptCharacters >= MAX_TOTAL_PROMPT_CHARACTERS
		) {
			break;
		}
	}
	if (
		selectedItems.length <
		sessions.reduce((total, session) => total + session.prompts.length, 0)
	) {
		truncated = true;
	}

	const batches: ClassificationBatch[] = [];
	let pending: PromptItem[] = [];
	let pendingCharacters = 0;
	for (const item of selectedItems) {
		if (
			pending.length > 0 &&
			(pending.length >= MAX_BATCH_PROMPTS ||
				pendingCharacters + item.text.length > MAX_BATCH_CHARACTERS)
		) {
			batches.push({
				prompt: batchPrompt(pending, skillInstructions),
				items: pending,
			});
			pending = [];
			pendingCharacters = 0;
		}
		pending.push(item);
		pendingCharacters += item.text.length;
	}
	if (pending.length > 0) {
		batches.push({
			prompt: batchPrompt(pending, skillInstructions),
			items: pending,
		});
	}
	return {
		batches,
		items: selectedItems,
		promptCount: selectedItems.length,
		promptCharacters,
		truncated,
	};
}

function parseJsonObject(text: string): RawModelResponse {
	const unfenced = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("Classifier did not return JSON");
	}
	try {
		return JSON.parse(unfenced.slice(start, end + 1)) as RawModelResponse;
	} catch {
		throw new Error("Classifier returned invalid JSON");
	}
}

export function parseClassificationBatch(
	text: string,
	batch: ClassificationBatch,
): PromptClassification[] {
	const parsed = parseJsonObject(text);
	const rawClassifications = Array.isArray(parsed.classifications)
		? parsed.classifications
		: [];
	const byRef = new Map<string, RawClassification>();
	for (const raw of rawClassifications) {
		const promptRef = String(raw?.prompt_ref ?? "");
		if (promptRef && !byRef.has(promptRef)) byRef.set(promptRef, raw);
	}
	return batch.items.map((item) => {
		const raw = byRef.get(item.ref);
		const rawKind = String(raw?.kind ?? "");
		const kind = PROMPT_KINDS.has(rawKind as PromptKind)
			? (rawKind as PromptKind)
			: "unclear";
		const fallback = safeParaphrase(kind);
		let paraphrase = boundedText(raw?.paraphrase, fallback, 500);
		if (containsExactExcerpt(paraphrase, item.text)) paraphrase = fallback;
		const confidence = raw?.confidence === "high" ? "high" : "medium";
		const classification: PromptClassification = {
			id: `${item.sessionId}:${item.promptIndex}`,
			sessionId: item.sessionId,
			promptIndex: item.promptIndex,
			kind,
			paraphrase,
			confidence,
			repositories: item.repositories,
		};
		if (kind === "steering") {
			const category = String(raw?.steering_category ?? "");
			classification.steeringCategory = STEERING_CATEGORIES.has(
				category as SteeringCategory,
			)
				? (category as SteeringCategory)
				: "course_correction";
			let expectedBehavior = boundedText(
				raw?.expected_behavior,
				"Adjust the current approach to follow the user's correction.",
				500,
			);
			if (containsExactExcerpt(expectedBehavior, item.text)) {
				expectedBehavior =
					"Adjust the current approach to follow the user's correction.";
			}
			classification.expectedBehavior = expectedBehavior;
		}
		return classification;
	});
}

export function buildThemePrompt(
	classifications: PromptClassification[],
	skillInstructions: string,
): { prompt: string; refs: Map<string, PromptClassification> } | undefined {
	const steering = classifications.filter(
		(classification) => classification.kind === "steering",
	);
	if (steering.length === 0) return undefined;
	const refs = new Map<string, PromptClassification>();
	const lines = steering.map((classification, index) => {
		const ref = `C${String(index + 1).padStart(3, "0")}`;
		refs.set(ref, classification);
		return `${ref} | category=${classification.steeringCategory} | repositories=${classification.repositories.join(", ") || "unresolved"} | paraphrase=${JSON.stringify(classification.paraphrase)} | expected=${JSON.stringify(classification.expectedBehavior ?? "")}`;
	});
	return {
		refs,
		prompt: `Apply the packaged skill below in Theme mode. Return only the JSON required by the skill.

BEGIN PACKAGED SKILL
${skillInstructions}
END PACKAGED SKILL

BEGIN STEERING CLASSIFICATIONS
${lines.join("\n")}
END STEERING CLASSIFICATIONS`,
	};
}

export function parseThemes(
	text: string,
	refs: Map<string, PromptClassification>,
): SteeringTheme[] {
	const parsed = parseJsonObject(text);
	const rawThemes = Array.isArray(parsed.themes) ? parsed.themes : [];
	const themes: SteeringTheme[] = [];
	for (const raw of rawThemes.slice(0, 12)) {
		if (!raw || !Array.isArray(raw.classification_refs)) continue;
		const classifications = raw.classification_refs.flatMap((ref) => {
			const classification = refs.get(String(ref));
			return classification ? [classification] : [];
		});
		if (classifications.length === 0) continue;
		const title = boundedText(raw.title, "Steering pattern", 120);
		const summary = boundedText(
			raw.summary,
			"The user repeatedly redirected the agent on a related concern.",
			700,
		);
		const repositoryAction = boundedText(raw.repository_action, "", 700);
		const repositories = [
			...new Set(
				classifications.flatMap((classification) => classification.repositories),
			),
		].sort((a, b) => a.localeCompare(b));
		const theme: SteeringTheme = {
			id: `theme-${themes.length + 1}`,
			title,
			summary,
			promptIds: classifications.map((classification) => classification.id),
			repositories,
		};
		if (repositoryAction) theme.repositoryAction = repositoryAction;
		themes.push(theme);
	}
	return themes;
}
