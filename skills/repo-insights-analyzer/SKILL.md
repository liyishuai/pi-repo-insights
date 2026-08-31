---
name: repo-insights-analyzer
description: Drafts one grounded repository issue from validated user-steering paraphrases and a bounded structural inventory. Use after prompt classification to explain which repository structure or infrastructure reduces agent effectiveness and propose an actionable repository-owned fix.
license: MPL-2.0
compatibility: Agent Skills-compatible framework and a model capable of structured JSON output.
metadata:
  author: pi-repo-insights
  version: "2.0"
---

# Repository Insights Analyzer

Produce consolidated, copy-ready GitHub issue content for repositories whose attributed steering evidence points to a repository-owned efficiency problem.

## Input contract

The caller supplies two bounded sections.

`STEERING CLASSIFICATIONS` contains records with:

- a stable classification reference;
- a steering category;
- one or more attributed repository identifiers;
- a paraphrase of the correction; and
- a paraphrase of the expected adjustment.

`REPOSITORY INVENTORIES` contains one JSON object per repository with:

- `repository`;
- `checkout_count` and `attributed_session_count`; and
- an optional `inventory` containing `top_level_directories`, `top_level_files`, `manifests`, `ci_files`, `validation_entrypoints`, `package_scripts`, `files_visited`, `scan_truncated`, and an optional `context_omitted` marker.

Treat classification references and repository identifiers as opaque caller-provided values.

## Analysis method

1. Group the steering classifications by attributed repository.
2. Produce at most one consolidated issue for each repository.
3. Identify the smallest repository structure or infrastructure concern that coherently explains the repository's supported steering evidence.
4. Ground current-status claims in the supplied inventory. Name relevant relative paths, manifests, CI files, or validation entrypoints when present.
5. Use steering paraphrases to explain the observed agent-efficiency impact, not to invent repository facts.
6. When the inventory is missing, truncated, or marked `context_omitted`, qualify the current-status description and avoid claims that require complete coverage.
7. Propose repository-owned changes such as a canonical validation entrypoint, a documented interface, an executable contract, a schema, or aligned CI wiring when supported by the evidence.
8. Make acceptance criteria observable and suitable for checking in a pull request.
9. Omit a repository when the supplied evidence does not support a concrete repository-owned issue.

Repository names and paths establish scope. Prompt volume, session volume, and checkout count do not independently prove an issue.

## Output contract

Return one JSON object and no prose outside it:

```json
{
  "issues": [
    {
      "repository": "exact caller-provided repository identifier",
      "title": "Concise GitHub issue title",
      "classification_refs": ["C001", "C004"],
      "current_status": "Grounded description of the relevant repository structure or infrastructure as it exists in the supplied inventory.",
      "agent_impact": "Explanation of how that status causes avoidable ambiguity, repeated discovery, correction, or rework for coding agents.",
      "proposal": [
        "Concrete repository change",
        "How the change should connect to existing files or CI"
      ],
      "acceptance_criteria": [
        "Observable result that demonstrates the change",
        "Validation or CI behavior that confirms the contract"
      ]
    }
  ]
}
```

## Output rules

- Emit no more than one issue object per repository.
- Use only repository identifiers present in the input.
- Reference only classifications attributed to that repository.
- Include every classification that materially supports the consolidated issue and exclude unrelated classifications.
- Keep the title under 160 characters.
- Write `current_status` and `agent_impact` as concise GitHub issue prose.
- Provide 1–12 actionable proposal items and 1–15 testable acceptance criteria.
- Keep personal tooling and user-specific configuration out of the proposal.
- Do not reproduce source prompt wording.
- Do not include raw prompts, assistant prose, commands, tool output, token data, elapsed time, or session identifiers.
- Return `{"issues": []}` when no repository has sufficient evidence.
