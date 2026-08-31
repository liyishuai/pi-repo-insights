// SPDX-License-Identifier: MPL-2.0

import type {
	PromptClassification,
	PromptKind,
	RepositoryAttribution,
	RepositoryInventory,
	RepositoryIssueDraft,
	SessionEvidence,
	SteeringCategory,
} from "./types.ts";

const MAX_PROMPTS = 500;
const MAX_TOTAL_PROMPT_CHARACTERS = 120_000;
const MAX_SESSION_PROMPTS = 150;
const MAX_SESSION_CHARACTERS = 30_000;
const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_BATCH_PROMPTS = 160;
const MAX_BATCH_CHARACTERS = 40_000;
const MAX_ANALYSIS_INVENTORY_CHARACTERS = 80_000;
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

type RawIssue = {
	repository?: string | null;
	title?: string | null;
	classification_refs?: string[];
	current_status?: string | null;
	agent_impact?: string | null;
	proposal?: string[];
	acceptance_criteria?: string[];
};

type RawModelResponse = {
	classifications?: RawClassification[];
	issues?: RawIssue[];
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

export type RepositoryAnalysisRequest = {
	prompt: string;
	refs: Map<string, PromptClassification>;
	repositoryKeys: Set<string>;
};

export function buildRepositoryAnalysisPrompt(
	classifications: PromptClassification[],
	repositories: RepositoryAttribution[],
	inventories: RepositoryInventory[],
	analysisSkill: string,
): RepositoryAnalysisRequest | undefined {
	const steering = classifications.filter(
		(classification) =>
			classification.kind === "steering" && classification.repositories.length > 0,
	);
	if (steering.length === 0) return undefined;
	const refs = new Map<string, PromptClassification>();
	const classificationLines = steering.map((classification, index) => {
		const ref = `C${String(index + 1).padStart(3, "0")}`;
		refs.set(ref, classification);
		return `${ref} | category=${classification.steeringCategory} | repositories=${classification.repositories.join(", ")} | paraphrase=${JSON.stringify(classification.paraphrase)} | expected=${JSON.stringify(classification.expectedBehavior ?? "")}`;
	});
	const inventoryByRepository = new Map(
		inventories.map((inventory) => [inventory.repository, inventory]),
	);
	const steeringRepositoryKeys = new Set(
		steering.flatMap((classification) => classification.repositories),
	);
	const relevantRepositories = repositories.filter((repository) =>
		steeringRepositoryKeys.has(repository.key),
	);
	if (relevantRepositories.length === 0) return undefined;
	let inventoryCharacters = 0;
	const repositoryLines = relevantRepositories.map((repository) => {
		const inventory = inventoryByRepository.get(repository.key);
		const repositoryContext = (mode: "full" | "compact" | "summary") => {
			const base = {
				repository: repository.key,
				checkout_count: repository.checkoutCount,
				attributed_session_count: repository.sessionIds.length,
			};
			if (!inventory) return { ...base, inventory: null };
			if (mode === "summary") {
				return {
					...base,
					inventory: {
						files_visited: inventory.filesVisited,
						scan_truncated: true,
						context_omitted: true,
					},
				};
			}
			const limited = (values: string[], maxItems: number) =>
				mode === "compact" ? values.slice(0, maxItems) : values;
			return {
				...base,
				inventory: {
					top_level_directories: limited(inventory.topLevelDirectories, 20),
					top_level_files: limited(inventory.topLevelFiles, 20),
					manifests: limited(inventory.manifests, 25),
					ci_files: limited(inventory.ciFiles, 25),
					validation_entrypoints: limited(
						inventory.validationEntrypoints,
						30,
					),
					package_scripts: limited(inventory.packageScripts, 30),
					files_visited: inventory.filesVisited,
					scan_truncated: inventory.truncated || mode === "compact",
				},
			};
		};
		let line = JSON.stringify(repositoryContext("full"));
		if (
			inventoryCharacters + line.length >
			MAX_ANALYSIS_INVENTORY_CHARACTERS
		) {
			line = JSON.stringify(repositoryContext("compact"));
		}
		if (
			inventoryCharacters + line.length >
			MAX_ANALYSIS_INVENTORY_CHARACTERS
		) {
			line = JSON.stringify(repositoryContext("summary"));
		}
		inventoryCharacters += line.length;
		return line;
	});
	return {
		refs,
		repositoryKeys: new Set(
			relevantRepositories.map((repository) => repository.key),
		),
		prompt: `Apply the packaged repository-analysis skill below. Return only the JSON required by the skill.

BEGIN PACKAGED SKILL
${analysisSkill}
END PACKAGED SKILL

BEGIN STEERING CLASSIFICATIONS
${classificationLines.join("\n")}
END STEERING CLASSIFICATIONS

BEGIN REPOSITORY INVENTORIES
${repositoryLines.join("\n")}
END REPOSITORY INVENTORIES`,
	};
}

function issueBody(
	currentStatus: string,
	agentImpact: string,
	proposal: string[],
	acceptanceCriteria: string[],
): string {
	return [
		"## Current status",
		"",
		currentStatus,
		"",
		"## Impact on agent effectiveness",
		"",
		agentImpact,
		"",
		"## Proposed change",
		"",
		...proposal.map((item) => `- ${item}`),
		"",
		"## Acceptance criteria",
		"",
		...acceptanceCriteria.map((item) => `- [ ] ${item}`),
	].join("\n");
}

function boundedList(value: string[] | undefined, maxItems: number): string[] {
	return (Array.isArray(value) ? value : [])
		.map((item) => boundedText(String(item), "", 500))
		.filter(Boolean)
		.slice(0, maxItems);
}

function groupRawIssues(
	rawIssues: RawIssue[],
	repositoryKeys: Set<string>,
): Map<string, RawIssue[]> {
	const grouped = new Map<string, RawIssue[]>();
	for (const raw of rawIssues.slice(0, 100)) {
		const repository = boundedText(raw?.repository, "", 300);
		if (!repository || !repositoryKeys.has(repository)) continue;
		const group = grouped.get(repository) ?? [];
		group.push(raw);
		grouped.set(repository, group);
	}
	return grouped;
}

function referencedClassifications(
	repository: string,
	drafts: RawIssue[],
	refs: Map<string, PromptClassification>,
): PromptClassification[] {
	const byId = new Map<string, PromptClassification>();
	for (const draft of drafts) {
		const draftRefs = Array.isArray(draft.classification_refs)
			? draft.classification_refs
			: [];
		for (const ref of draftRefs) {
			const classification = refs.get(String(ref));
			if (classification?.repositories.includes(repository)) {
				byId.set(classification.id, classification);
			}
		}
	}
	return [...byId.values()];
}

function mergedIssueText(
	drafts: RawIssue[],
	field: "current_status" | "agent_impact",
	maxLength: number,
): string {
	return drafts
		.flatMap((draft) => {
			const value = boundedText(draft[field], "", maxLength);
			return value ? [value] : [];
		})
		.join("\n\n");
}

function issueFromDrafts(
	repository: string,
	drafts: RawIssue[],
	refs: Map<string, PromptClassification>,
	index: number,
): RepositoryIssueDraft | undefined {
	const first = drafts[0];
	if (!first) return undefined;
	const title = boundedText(first.title, "", 160);
	const currentStatus = mergedIssueText(drafts, "current_status", 1_200);
	const agentImpact = mergedIssueText(drafts, "agent_impact", 900);
	const proposal = [
		...new Set(drafts.flatMap((draft) => boundedList(draft.proposal, 12))),
	].slice(0, 12);
	const acceptanceCriteria = [
		...new Set(
			drafts.flatMap((draft) => boundedList(draft.acceptance_criteria, 15)),
		),
	].slice(0, 15);
	const classifications = referencedClassifications(repository, drafts, refs);
	if (
		!title ||
		!currentStatus ||
		!agentImpact ||
		proposal.length === 0 ||
		acceptanceCriteria.length === 0 ||
		classifications.length === 0
	) {
		return undefined;
	}
	return {
		id: `issue-${index}`,
		repository,
		title,
		currentStatus,
		agentImpact,
		proposal,
		acceptanceCriteria,
		body: issueBody(currentStatus, agentImpact, proposal, acceptanceCriteria),
		promptIds: classifications.map((classification) => classification.id),
	};
}

export function parseRepositoryAnalysis(
	text: string,
	request: RepositoryAnalysisRequest,
): RepositoryIssueDraft[] {
	const parsed = parseJsonObject(text);
	const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
	const grouped = groupRawIssues(rawIssues, request.repositoryKeys);
	const issues = [...grouped].flatMap(([repository, drafts], index) => {
		const issue = issueFromDrafts(repository, drafts, request.refs, index + 1);
		return issue ? [issue] : [];
	});
	return issues.sort((a, b) => a.repository.localeCompare(b.repository));
}
