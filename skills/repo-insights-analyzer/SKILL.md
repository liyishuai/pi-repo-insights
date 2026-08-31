---
name: repo-insights-analyzer
description: Analyzes validated, repository-attributed user-steering paraphrases from coding-agent sessions; groups recurring correction themes and proposes grounded repository-owned actions. Use after prompt classification to produce repository insights.
license: MPL-2.0
compatibility: Agent Skills-compatible framework and a model capable of structured JSON output.
---

# Repository Insights Analyzer

Analyze the supplied steering classifications. Each item contains a stable reference, steering category, repository attribution, a validated paraphrase of what the user signaled, and the expected agent adjustment.

The input is already classified. Preserve its meaning rather than reclassifying it.

## Repository analysis

1. Group repeated or tightly related corrections into coherent themes.
2. Keep unrelated corrections separate; omit a theme when the evidence is too weak to describe a pattern.
3. Use `classification_refs` to retain the exact evidence membership of each theme.
4. Attribute a theme only to repositories present on its referenced classifications.
5. Write a concise `summary` of the user-observed agent problem.
6. Set `repository_action` to a repository-owned script, check, CI contract, schema, or documented interface when the grouped steering directly supports that action.
7. Use `null` when the evidence describes agent behavior without supporting a repository change.

Repository names and paths identify scope. They do not independently prove a theme or justify an action.

Return JSON only:

```json
{
  "themes": [
    {
      "title": "Short theme title",
      "classification_refs": ["C001"],
      "summary": "Paraphrased recurring correction",
      "repository_action": null
    }
  ]
}
```

## Evidence discipline

- Base every theme on the supplied steering paraphrases and expected adjustments.
- Preserve distinctions between scope, unwanted actions, missed requirements, frustration, premature completion, and evidence challenges.
- Prefer a small set of specific themes over broad summaries that hide different user concerns.
- Keep repository actions directly traceable to the theme's steering evidence.
