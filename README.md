# pi-repo-insights

A Pi package that reviews historical **user prompts**, distinguishes new requests from corrective steering, and drafts grounded repository issues for the repositories involved.

The central question is: _where did the user indicate that the agent's current approach was wrong?_ A forceful initial order is still a request; a later prompt that rejects, corrects, narrows, stops, or replaces the work is steering.

## Install

Pi packages execute code with your user permissions. Review the source before installing.

```bash
pi install git:github.com/liyishuai/pi-repo-insights
```

To install it for one trusted project instead of globally:

```bash
pi install -l git:github.com/liyishuai/pi-repo-insights
```

To try the extension without adding it to settings:

```bash
pi -e git:github.com/liyishuai/pi-repo-insights
```

Reload Pi after installation, then run `/repo-insights`.

## Usage

Run one command with no arguments:

```text
/repo-insights
```

The command opens an interactive configuration panel with five fields:

- **History window** — all history or the last 7, 30, 90, 180, or 365 days;
- **Session limit** — 25, 50, 100, 200, 500, or 1,000 recent sessions;
- **Model catalog** — `scoped` follows Pi's scoped models (or all models when no scope is configured), while `all` always shows every authenticated model;
- **Classifier model** — classifies each prompt, defaulting to `openai-codex/gpt-5.3-codex-spark`; and
- **Repository analysis model** — drafts one consolidated issue per supported repository, defaulting to `openai-codex/gpt-5.6-luna`.

Select **Run analysis** in the panel to start. Selections are remembered globally in `~/.pi/agent/repo-insights/config.json` (or the equivalent path under `PI_CODING_AGENT_DIR`). If a preferred model is unavailable, the extension falls back to Pi's active model.

Reports are written to:

```text
~/.pi/agent/repo-insights/report.md
~/.pi/agent/repo-insights/report.json
```

The Markdown report summarizes class counts and provides one copy-ready GitHub issue draft per supported repository. Each issue body explains the relevant current repository or infrastructure status, its impact on agent effectiveness, a proposed change, and testable acceptance criteria. The schema-versioned JSON report retains classifications, bounded repository inventories, and structured issue drafts.

## Models and classification skill

Every included chronological user prompt receives one primary class:

- **request** — a new or additive order, desired outcome, preference, or question;
- **steering** — a reaction to current or previous agent behavior that rejects, corrects, redirects, narrows, expands, stops, or replaces the approach;
- **response** — information, approval, or a choice supplied because the agent asked;
- **other** — acknowledgement, status-only content, or content outside those classes; or
- **unclear** — the classifier omitted or malformed the result.

If a prompt both redirects the agent and gives a new order, steering takes priority. Steering is further classified as course correction, scope reassertion, frustration, missed requirement, unwanted action, premature completion, or evidence challenge.

Two packaged Agent Skills define the semantic work:

- `skills/repo-insights-classifier/SKILL.md` classifies requests, steering, responses, and other prompts.
- `skills/repo-insights-analyzer/SKILL.md` combines repository-attributed steering with a bounded structural inventory and drafts grounded repository issues.

Pi discovers them as `/skill:repo-insights-classifier` and `/skill:repo-insights-analyzer`. Their frontmatter, input contracts, decision rules, and JSON outputs are self-contained, so another Agent Skills-compatible framework can copy or reference either skill directory directly. `extensions/repo-insights.ts` is the Pi adapter for session loading, the configuration panel, model selection, and report writing.

Classification runs as bounded, stateless model tasks on Spark by default. Validated steering paraphrases and bounded repository inventories are passed to the separate Luna repository-analysis task. Prompt batches are limited to 160 prompts and 40,000 prompt characters. A run submits at most 500 prompts and 120,000 prompt characters; the report marks truncated coverage.

## Repository attribution

Repository facts are used only after prompt classification:

1. Session working directories and tool path arguments identify candidate local Git roots.
2. Origin remotes and explicit GitHub references consolidate checkouts under one repository identity.
3. Prompt classifications inherit the repositories associated with their session.
4. A bounded read-only inventory records top-level entries, manifests, CI files, validation entrypoints, and package script names. Each local inventory visits at most 10,000 entries and 5,000 files to a depth of three.
5. The repository-analysis skill uses attributed steering plus that inventory to draft at most one grounded issue per repository.

## Privacy and boundaries

- Classifier input consists of selected chronological user prompts.
- Analysis input consists of validated steering paraphrases and bounded repository inventories.
- Inventories contain relative entry names and package-script keys rather than repository source contents.
- The Markdown report contains synthesized issue drafts; the JSON report contains validated paraphrases rather than raw prompt text.
- Host validation replaces a paraphrase if it copies eight consecutive words from its source prompt.
- Repository attribution resolves local Git roots and origin remotes without a GitHub API call.
- The JSON report includes local paths and repository identities for attribution.
- The two packaged Agent Skills provide the portable classification and repository-analysis contracts.

The current report schema is `schemaVersion: 3`.

## Development

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run check
```

Load the extension directly, then enter `/repo-insights` to inspect the configuration panel and run it:

```bash
pi --no-extensions --extension ./extensions/repo-insights.ts
```

## License

[MPL-2.0](LICENSE)
