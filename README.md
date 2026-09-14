<p align="center">
  <img src="assets/header.svg" alt="Convoy — from intent to ship" width="920">
</p>

<p align="center">
  <a href="https://github.com/Inakitajes/convoy/actions/workflows/ci.yml"><img src="https://github.com/Inakitajes/convoy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./assets/coverage.svg"><img src="assets/coverage.svg" alt="coverage"></a>
  <img src="https://img.shields.io/github/v/release/Inakitajes/convoy?include_prereleases&label=release" alt="release">
  <img src="https://img.shields.io/github/license/Inakitajes/convoy" alt="license">
</p>

<p align="center">
  <img src="assets/screenshot.jpeg" alt="convoy running a pipeline with six parallel agents" width="920">
</p>

Convoy orchestrates AI coding agents from a task or spec to a reviewed implementation. Run it from the terminal UI or CLI, choose a model for each step, and keep the reports, costs, and Git history together.

[Documentation](docs/README.md) · [Installation](docs/getting-started.md) · [Pipelines](docs/pipelines.md) · [Releases](https://github.com/Inakitajes/convoy/releases)

## What Convoy does

- **Multi-model pipelines.** Implement, audit, test, and review with specialized agents and optional advisors. [Choose a workflow →](docs/pipelines.md)
- **Measured quality.** Independent scorers and a verified consensus drive bounded rounds of targeted fixes. [Quality and goals →](docs/quality-and-goals.md)
- **Worktrees and living specs.** Create isolated work, discuss a change, run it against an OpenSpec contract, and review its path to a PR. [Worktrees →](docs/worktrees.md) · [OpenSpec →](docs/openspec.md)
- **Runs you can follow and resume.** Watch parallel steps, inspect reports and usage, detach from a live run, and return later. [Running Convoy →](docs/running.md)
- **Control over agent actions.** Configure permission gates, smart approval, commit checks, hooks, and project instructions. [Safety →](docs/safety.md) · [Configuration →](docs/configuration.md)

## Get started

Requires macOS or Linux, Git, and an installed, authenticated [OpenCode](https://opencode.ai). The default pipeline uses OpenRouter and OpenAI models. Bun is bundled in the release binary.

```sh
curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | sh
```

Open `convoy` in your project for the terminal UI, or start from the CLI:

```sh
convoy --prompt-file prd.md       # implement, measure, and fix with full-cycle
convoy -p review                 # report-only review of the current branch
convoy -p ship                   # sync, review, fix, and measure the branch
```

See [installation and updates](docs/getting-started.md), [provider setup](docs/models.md), and [CLI usage](docs/running.md).

## Pick a pipeline

| Pipeline | Purpose |
|---|---|
| `full-cycle` · default | Implement, audit, test, score, and fix gaps in a bounded loop. |
| `implement` | Implement and audit, then produce a run recap. |
| `ship` | Sync with the base, review and fix findings, then reach the quality target. |
| `review` | Produce findings and a verified score without changing code. |
| `fixer` | Reproduce supplied findings, fix them, and verify the result. |
| `hunter` | Audit six specialty tracks across five models, then reconcile the findings. |

[Models, steps, and stopping rules →](docs/pipelines.md)

## Documentation

| Guide | Covers |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, installation, and upgrades |
| [Pipelines](docs/pipelines.md) | Built-ins, models, and migration from earlier variants |
| [Quality and goals](docs/quality-and-goals.md) | Scoring rubric and improve/measure loops |
| [Worktrees](docs/worktrees.md) | Home, isolation, spin, and close |
| [OpenSpec](docs/openspec.md) | Spec-driven runs and the artifact reader |
| [Running Convoy](docs/running.md) | CLI, TUI, live sessions, history, and resume |
| [Configuration](docs/configuration.md) | Agents, advisors, prompts, hooks, and attachments |
| [Permissions and safety](docs/safety.md) | Approval policies, commits, compaction, and publication |
| [Models and providers](docs/models.md) | Authentication and model gateways |
| [Development](docs/development.md) | Building, testing, and the source layout |
