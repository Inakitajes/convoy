# Pipelines

[Documentation](README.md) · [Convoy](../README.md)

Choose a built-in workflow and understand its models, advisors, and outputs.

- [The default pipeline: `full-cycle`](#the-default-pipeline-full-cycle)
- [Built-in pipelines](#built-in-pipelines)

## The default pipeline: `full-cycle`

`full-cycle` runs when you do not pass `-p/--pipeline` or configure `defaults.pipeline`. It implements the change, then measures and fixes it against the quality rubric.

```text
PRD → implementer → patterns → security → design → tests → measure
                                                           ↑    │
                                                           └ fix┘
```

All model IDs below are public provider IDs. The former local NAN models use their OpenRouter equivalents: `openrouter/deepseek/deepseek-v4.1-flash#high` and `openrouter/z-ai/glm-5.3-flash#high`.

| Step | Model | Advisor |
|---|---|---|
| `implementer` | DeepSeek V4.1 Flash · high | GPT 6 Astra · xhigh |
| `patterns` | DeepSeek V4.1 Flash · high | GLM 5.3 · high |
| `security` | GLM 5.3 Flash · high | GLM 5.3 · high |
| `design` | GLM 5.3 Flash · high | GPT 6 Astra · xhigh |
| `tests` | DeepSeek V4.1 Flash · high | GLM 5.3 · high |
| Goal: independent scorers | Grok 4.6 · high + GLM 5.3 · high | — |
| Goal: verified consensus | GLM 5.3 · high | — |
| Goal: targeted fixes | DeepSeek V4.1 Flash · high | GPT 6 Astra · xhigh |

The goal measures first, then fixes only reported gaps. It stops at **90/100**, after **five fix rounds**, or on the configured plateau limit (three rounds by default). A run that hits a limit can finish below the target; inspect its final score. Scorers read the original requirements and current diff without previous reports; the consensus reads only the current scorer reports and verifies their claims.

OpenRouter serves DeepSeek, GLM and Grok. Astra and Sol use the OpenAI provider. [Advisor settings](configuration.md#project-configuration-convoyconfigyaml) control consultation limits.

## Built-in pipelines

Select one with `-p/--pipeline`; no project config is needed. `full-cycle` is the default. For a workflow with manual editing between implementation and release preparation, run `convoy -p implement`, make your edits, then run `convoy -p ship`.

| Pipeline | Changes code? | What it does |
|---|---|---|
| `full-cycle` | yes | Implement, audit, polish and test with the models above, then independently score and fix gaps up to five times to reach 90/100. |
| `implement` | yes | DeepSeek V4.1 Flash implements with Astra xhigh advice. Patterns and tests use DeepSeek; security and design use GLM Flash. Those later steps run unadvised. Closes with a read-only DeepSeek recap at `reports/run-report.md`; no scoring loop. |
| `ship` | yes | Sync with the base; scope and review the diff across DeepSeek and GLM Flash; report, adversarially triage and fix accepted findings with Astra advice; recap; then score with Grok and GLM, reconcile on GLM and fix gaps up to five times to reach 90/100. |
| `review` | no | The report-only review: DeepSeek scopes and reports; clean-code, security and bug audits each run on DeepSeek and GLM Flash. Grok and GLM score independently, then GLM verifies the consensus. Produces findings and a quality score. |
| `fixer` | yes | Prove supplied findings with regression tests, apply targeted fixes, then independently rerun the checks. Terra xhigh handles all three phases; Astra xhigh advises reproduction and fixes. |
| `hunter` | no | The maximum-coverage audit: six specialty tracks each run on Terra, Opus via OpenRouter, GLM 5.3, Kimi K3 and Grok 4.6 (30 audits), followed by a Sol xhigh consensus. |

`ship` needs permission to merge and resolve conflicts: configure `permissions.allow` for `git merge*`, `git add*`, and `git checkout --ours*` / `--theirs*`, or approve those operations when asked. Optional `hooks.pipelines.ship` can fetch the base before the run and call `convoy publish` afterwards. PR creation is not part of the built-in pipeline itself; a post-hook can require `CONVOY_GOAL_REACHED=true` before publishing.

`review` assesses the current branch/PR diff; `hunter` defaults to the whole repository unless the prompt narrows its scope. `fixer` takes specific findings and produces a verdict for each.

The catalog consolidates the former variants: `review-lite` is now `review`, `astra` is now `full-cycle`, and `hunter-max` is now `hunter`; `review-cc`, the previous `review`, `implement-lite`, and the previous `full-cycle` and `hunter` definitions are removed. Existing global or project pipeline overrides still take precedence: rename or remove those entries to use the new built-ins. Frozen pipelines in saved runs remain available to `--resume`.

---

[Back to documentation](README.md)
