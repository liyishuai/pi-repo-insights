// SPDX-License-Identifier: MPL-2.0

import type { Dirent } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
	RepositoryAttribution,
	RepositoryInventory,
} from "./types.ts";

const MAX_FILES = 5_000;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 3;
const MAX_TOP_LEVEL_ENTRIES = 80;
const MAX_FACTS_PER_CATEGORY = 100;
const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".turbo",
	".cache",
]);
const MANIFEST_NAMES = new Set([
	"package.json",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"package-lock.json",
	"go.mod",
	"go.work",
	"cargo.toml",
	"pyproject.toml",
	"poetry.lock",
	"requirements.txt",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"gemfile",
	"composer.json",
	"makefile",
	"justfile",
	"taskfile.yml",
	"taskfile.yaml",
	"nx.json",
	"turbo.json",
]);
const PACKAGE_SCRIPT = /^(?:test|check|ci|lint|typecheck|validate|verify|build)(?::|-|$)/i;
const VALIDATION_FILE = /^(?:ci|check|validate|verify|test)(?:\.[A-Za-z0-9_-]+)?$/i;

function normalizedRelative(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

async function nestedGitCheckout(path: string): Promise<boolean> {
	try {
		await access(join(path, ".git"));
		return true;
	} catch {
		return false;
	}
}

function isCiFile(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		(/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) ||
			lower === ".gitlab-ci.yml" ||
			lower === "jenkinsfile" ||
			lower === ".circleci/config.yml" ||
			lower === "azure-pipelines.yml" ||
			lower === ".buildkite/pipeline.yml" ||
			lower === "bitrise.yml")
	);
}

function isValidationFile(path: string): boolean {
	const segments = path.split("/");
	const file = segments.at(-1) ?? "";
	const parent = segments.at(-2)?.toLowerCase() ?? "";
	return (
		(["scripts", "bin", "tools"].includes(parent) && VALIDATION_FILE.test(file)) ||
		["makefile", "justfile", "taskfile.yml", "taskfile.yaml"].includes(
			path.toLowerCase(),
		)
	);
}

async function packageScriptFacts(
	root: string,
	manifestPath: string,
): Promise<{ scripts: string[]; entrypoints: string[] }> {
	try {
		const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const names = Object.keys(manifest.scripts ?? {}).sort((a, b) =>
			a.localeCompare(b),
		);
		return {
			scripts: names.map((name) => `${manifestPath}#scripts.${name}`),
			entrypoints: names.flatMap((name) =>
				PACKAGE_SCRIPT.test(name)
					? [`${manifestPath}#scripts.${name}`]
					: [],
			),
		};
	} catch {
		return { scripts: [], entrypoints: [] };
	}
}

type DirectoryCursor = {
	directory: string;
	depth: number;
};

function emptyInventory(repository: string): RepositoryInventory {
	return {
		repository,
		topLevelDirectories: [],
		topLevelFiles: [],
		manifests: [],
		ciFiles: [],
		validationEntrypoints: [],
		packageScripts: [],
		filesVisited: 0,
		truncated: false,
	};
}

async function directoryEntries(directory: string): Promise<Dirent[] | undefined> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return undefined;
	}
}

function addBoundedFact(
	target: string[],
	value: string,
	limit: number,
	inventory: RepositoryInventory,
): void {
	if (target.length < limit) {
		target.push(value);
	} else {
		inventory.truncated = true;
	}
}

function recordTopLevelEntry(
	entry: Dirent,
	depth: number,
	ignoredDirectory: boolean,
	inventory: RepositoryInventory,
): void {
	if (depth !== 0 || entry.name === ".git" || ignoredDirectory) return;
	const target = entry.isDirectory()
		? inventory.topLevelDirectories
		: inventory.topLevelFiles;
	addBoundedFact(target, entry.name, MAX_TOP_LEVEL_ENTRIES, inventory);
}

function recordFileFacts(path: string, inventory: RepositoryInventory): void {
	inventory.filesVisited++;
	const lowerName = basename(path).toLowerCase();
	if (MANIFEST_NAMES.has(lowerName)) {
		addBoundedFact(
			inventory.manifests,
			path,
			MAX_FACTS_PER_CATEGORY,
			inventory,
		);
	}
	if (isCiFile(path)) {
		addBoundedFact(inventory.ciFiles, path, MAX_FACTS_PER_CATEGORY, inventory);
	}
	if (isValidationFile(path)) {
		addBoundedFact(
			inventory.validationEntrypoints,
			path,
			MAX_FACTS_PER_CATEGORY,
			inventory,
		);
	}
}

async function inspectEntry(
	root: string,
	current: DirectoryCursor,
	entry: Dirent,
	inventory: RepositoryInventory,
): Promise<DirectoryCursor | undefined> {
	const absolute = join(current.directory, entry.name);
	const ignoredDirectory =
		entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name);
	recordTopLevelEntry(entry, current.depth, ignoredDirectory, inventory);
	if (entry.isSymbolicLink()) return undefined;
	if (entry.isFile()) {
		recordFileFacts(normalizedRelative(root, absolute), inventory);
		return undefined;
	}
	if (!entry.isDirectory() || ignoredDirectory) return undefined;
	if (current.depth >= MAX_DEPTH) {
		inventory.truncated = true;
		return undefined;
	}
	if (await nestedGitCheckout(absolute)) return undefined;
	return { directory: absolute, depth: current.depth + 1 };
}

async function scanRepository(
	root: string,
	inventory: RepositoryInventory,
): Promise<void> {
	const queue: DirectoryCursor[] = [{ directory: root, depth: 0 }];
	let queueIndex = 0;
	let entriesVisited = 0;
	while (
		queueIndex < queue.length &&
		inventory.filesVisited < MAX_FILES &&
		entriesVisited < MAX_ENTRIES
	) {
		const current = queue[queueIndex++];
		if (!current) break;
		const entries = await directoryEntries(current.directory);
		if (!entries) {
			inventory.truncated = true;
			continue;
		}
		for (const entry of entries) {
			if (
				inventory.filesVisited >= MAX_FILES ||
				entriesVisited >= MAX_ENTRIES
			) {
				inventory.truncated = true;
				break;
			}
			entriesVisited++;
			const next = await inspectEntry(root, current, entry, inventory);
			if (next) queue.push(next);
		}
	}
	if (queueIndex < queue.length) inventory.truncated = true;
}

function boundedUniqueFacts(
	values: string[],
	inventory: RepositoryInventory,
): string[] {
	const unique = [...new Set(values)].sort((a, b) => a.localeCompare(b));
	if (unique.length > MAX_FACTS_PER_CATEGORY) inventory.truncated = true;
	return unique.slice(0, MAX_FACTS_PER_CATEGORY);
}

async function addPackageScriptFacts(
	root: string,
	inventory: RepositoryInventory,
): Promise<void> {
	for (const manifest of inventory.manifests.filter(
		(path) => basename(path).toLowerCase() === "package.json",
	)) {
		const facts = await packageScriptFacts(root, manifest);
		inventory.packageScripts.push(...facts.scripts);
		inventory.validationEntrypoints.push(...facts.entrypoints);
	}
	inventory.packageScripts = boundedUniqueFacts(
		inventory.packageScripts,
		inventory,
	);
	inventory.validationEntrypoints = boundedUniqueFacts(
		inventory.validationEntrypoints,
		inventory,
	);
}

async function inventoryRepository(
	repository: RepositoryAttribution,
): Promise<RepositoryInventory> {
	const inventory = emptyInventory(repository.key);
	if (!repository.root) return inventory;
	await scanRepository(repository.root, inventory);
	await addPackageScriptFacts(repository.root, inventory);
	inventory.manifests.sort((a, b) => a.localeCompare(b));
	inventory.ciFiles.sort((a, b) => a.localeCompare(b));
	return inventory;
}

export async function buildRepositoryInventories(
	repositories: RepositoryAttribution[],
): Promise<RepositoryInventory[]> {
	const inventories: RepositoryInventory[] = [];
	const concurrency = 8;
	for (let index = 0; index < repositories.length; index += concurrency) {
		inventories.push(
			...(await Promise.all(
				repositories.slice(index, index + concurrency).map(inventoryRepository),
			)),
		);
	}
	return inventories;
}
