# pi-repo-insights

A local, deterministic Pi package that turns historical Pi sessions into evidence-backed **repository-level** improvement opportunities.

It is designed for multi-repository engineering work where agents repeatedly have to rediscover repository layout, reconcile CI state, trace dependency promotion, or reconstruct validation commands. Session duration is deliberately treated as neutral: a long session can represent useful sustained context, waiting, or monitoring.

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

```text
/repo-insights [options]

Options:
  --since <N>d          Analyze sessions modified in the last N days
  --max-sessions <N>    Bound session loading (default: 200, maximum: 2000)
  --output <directory>  Write report.md and report.json here
  -h, --help            Show help
```

By default, reports are written to:

```text
~/.pi/agent/repo-insights/report.md
~/.pi/agent/repo-insights/report.json
```

The Markdown file is for review; the schema-versioned JSON file is intended for follow-on repository automation.

## What it analyzes

The command:

1. Lists local Pi session files and loads the newest bounded set.
2. Extracts repository evidence from working directories, tool paths, GitHub references, tool failures, and repeated Git/GitHub/test operation categories.
3. Resolves local Git roots and origin remotes, consolidating temporary worktrees under one repository identity.
4. Performs bounded local inspection of manifests, test-like files, canonical validation entrypoints, GitHub Actions workflows, and Go dependency edges.
5. Applies explicit deterministic thresholds and writes Markdown plus JSON reports.

Current opportunity detectors cover:

- a versioned multi-repository workspace manifest;
- a structured cross-repository CI status record;
- schema-validated promotion state that renders tracker prose;
- automated dependency-closure verification;
- one CI-parity validation entrypoint per repository; and
- a typed operations index for large manual-workflow surfaces.

Recommendations appear only when their evidence thresholds are met. Ordinary failures, token counts, worktree use, and elapsed session time do not independently create findings.

## Privacy and boundaries

- All analysis runs locally.
- The extension makes no model calls.
- It performs no GitHub API calls and no other network requests.
- Prompt text, assistant prose, full commands, file contents, and tool outputs are not copied into reports.
- Local paths and repository identities do appear because they are required to resolve repository topology.
- Repository scans are bounded to 50,000 files per repository and skip common generated/vendor directories and nested Git checkouts.
- Repository instruction/context files are not inspected, generated, or recommended.

The current report schema is `schemaVersion: 1`.

## Development

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run check
```

Load the extension directly during development:

```bash
pi --no-extensions --extension ./extensions/repo-insights.ts
```

A non-interactive smoke test can exercise the real command without a model call:

```bash
pi --offline --no-session --no-context-files --no-extensions --no-skills \
  --extension ./extensions/repo-insights.ts --print \
  "/repo-insights --max-sessions 1 --output /tmp/pi-repo-insights-check"
```

## License

[MPL-2.0](LICENSE)
