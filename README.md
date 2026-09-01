# pi-repo-insights

A Pi package that turns repository friction into reviewable GitHub issue proposals.

With no direction, it reviews historical **user prompts**, distinguishes new requests from corrective steering, and finds repository-owned changes that could reduce repeated correction or rework. With a direction, it analyzes that direction against the current repository without reading or classifying session history.

Before proposing anything, the analyzer reads the repository's contribution guidance and issue templates and searches its open GitHub issues and pull requests. It never posts comments. It creates an issue only after showing the complete proposal and receiving explicit approval.

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

Reload Pi after installation.

## Commands

### Configure

```text
/repo-insights-config
```

This is the only command that opens the configuration panel. It controls:

- **History window** — all history or the last 7, 30, 90, 180, or 365 days;
- **Session limit** — 25, 50, 100, 200, 500, or 1,000 recent sessions;
- **Model catalog** — `scoped` follows Pi's scoped models, while `all` shows every authenticated model;
- **Classifier model** — defaults to `openai-codex/gpt-5.3-codex-spark`; and
- **Repository analysis model** — defaults to `openai-codex/gpt-5.6-luna`.

Selections are stored globally in `~/.pi/agent/repo-insights/config.json`, or the equivalent path under `PI_CODING_AGENT_DIR`. If a configured model is unavailable, the extension falls back to an available Pi model.

### Analyze historical steering

```text
/repo-insights
```

The command runs immediately using the saved configuration. It loads bounded session history, classifies chronological human prompts, and analyzes validated steering attributed to repositories.

### Analyze an explicit direction

```text
/repo-insights improve the repository's canonical validation guidance
```

Any non-empty sentence after the command is treated as the analysis direction. This path skips session loading and prompt classification entirely and analyzes the current repository directly.

Do not pass flags; the optional input is natural-language direction.

## Interactive issue flow

For each candidate, the extension:

1. builds a bounded structural inventory of the repository;
2. asks the analyzer skill to call `inspect_repository_guidance`, which reads contribution guidelines and issue templates locally when possible and from GitHub otherwise;
3. asks the skill to call `search_open_github_threads` with bounded semantic searches covering both open issues and open pull requests;
4. stops and cites the closest relevant open thread when one already covers the proposed change;
5. otherwise prepares one issue title, body, and any template-requested labels;
6. shows the complete proposal in a confirmation dialog; and
7. submits it only if the user explicitly approves.

Multiple proposals are shown and approved sequentially. Declining one proposal makes no GitHub write and does not prevent the next proposal from being shown.

The extension never creates issue or pull-request comments. A relevant open pull request counts as an existing contribution thread and prevents a duplicate issue.

A new issue is suppressed when thread discovery or guidance inspection fails, because the analyzer has not established that the contribution is both non-duplicative and repository-compliant.

## GitHub access

Read and write operations try authenticated [`gh`](https://cli.github.com/) first:

```bash
gh auth login
```

Open-thread discovery falls back to public GitHub REST access. If `gh` is unavailable or not authenticated, issue creation can fall back to GitHub REST when `GH_TOKEN` or `GITHUB_TOKEN` is available. Ambiguous write failures are not retried, avoiding accidental duplicate issues. The fallback token needs permission to create issues in the target repository.

## Models and packaged skills

Every included chronological human prompt receives one primary class:

- **request** — a new or additive order, desired outcome, preference, or question;
- **steering** — a reaction that rejects, corrects, redirects, narrows, expands, stops, or replaces the current approach;
- **response** — information, approval, or a choice supplied because the agent asked;
- **other** — acknowledgement, status-only content, or content outside those classes; or
- **unclear** — an omitted or malformed classification.

A forceful initial order remains a request. When a prompt both redirects current work and adds a new order, steering takes priority.

Two portable Agent Skills define the semantic behavior:

- `skills/repo-insights-classifier/SKILL.md` classifies chronological human prompts.
- `skills/repo-insights-analyzer/SKILL.md` supports candidate, direction, and audit modes; it owns the open-thread audit and contribution-guidance rules.

Pi discovers them as `/skill:repo-insights-classifier` and `/skill:repo-insights-analyzer`. Another Agent Skills-compatible framework can copy or reference either skill directory. To use analyzer audit mode portably, the host must provide tools equivalent to `search_open_github_threads` and `inspect_repository_guidance`.

Pi-specific code is limited to session access, configuration and confirmation UI, model calls, bounded GitHub transport, and approved issue submission.

Classification runs as bounded stateless model calls. Batches are limited to 160 prompts and 40,000 prompt characters. A historical run submits at most 500 prompts and 120,000 prompt characters.

## Repository discovery

For historical analysis:

1. Session working directories and tool path arguments identify candidate local Git roots.
2. Origin remotes and explicit GitHub references consolidate checkouts under one repository identity.
3. Prompt classifications inherit repositories associated with their session.
4. A bounded read-only inventory records top-level entries, manifests, CI files, validation entrypoints, and package-script names.
5. The analyzer produces at most one candidate per repository.

Each local inventory visits at most 10,000 entries and 5,000 files to a depth of three. Direct-direction analysis uses the current working repository and the same inventory rules.

## Privacy and boundaries

- Behavioral classification uses only selected chronological human prompts.
- Raw prompts are submitted transiently for classification but are not persisted by this package.
- Candidate analysis receives validated paraphrases and bounded repository inventories.
- Audit analysis receives bounded open-thread excerpts, contribution guidelines, and issue templates.
- Host validation rejects a paraphrase that copies eight consecutive words from its source prompt.
- No Markdown or JSON analysis report is written.
- Only the global configuration file is persisted.
- No GitHub write occurs without a proposal-specific confirmation.

## Development

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run check
npm pack --dry-run
```

Load the extension directly:

```bash
pi --no-extensions --extension ./extensions/repo-insights.ts
```

Then use `/repo-insights-config`, `/repo-insights`, or `/repo-insights <direction>`.

## License

[MPL-2.0](LICENSE)
