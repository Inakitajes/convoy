# Convoy documentation

[Back to Convoy](../README.md)

Start with installation, choose a pipeline, then use the guides below as you work. These pages are the project wiki, versioned alongside the code.

## Guides

| Guide | What you will find |
|---|---|
| [Getting started](getting-started.md) | Install Convoy, check the requirements, and update your binary. |
| [Pipelines](pipelines.md) | Choose a built-in workflow and understand its models, advisors, and outputs. |
| [Quality and goal loops](quality-and-goals.md) | Read the scoring rubric and configure bounded improve-and-measure loops. |
| [Worktrees and delivery](worktrees.md) | Manage work in isolated checkouts, from planning through close. |
| [OpenSpec workflows](openspec.md) | Use a living specification as the contract for implementation and review. |
| [Running Convoy](running.md) | Launch, observe, resume, and inspect runs from the CLI or TUI. |
| [Configuration](configuration.md) | Configure pipelines, agents, advisors, hooks, and project context. |
| [Permissions and safety](safety.md) | Control agent actions, protect commits, and understand finalization and publication. |
| [Models and providers](models.md) | Authenticate providers and route executor and advisor models through gateways. |
| [Development guide](development.md) | Build Convoy, run checks, and find the main source modules. |

## Common tasks

- **Start a new feature:** [choose a pipeline](pipelines.md#built-in-pipelines) and [create an isolated worktree](worktrees.md#isolating-a-run-in-a-worktree).
- **Work from a spec:** [select an OpenSpec change](openspec.md#openspec-native-runs) and [browse its artifacts](openspec.md#the-specs-reader-convoy-specs).
- **Review an existing branch:** run `convoy -p review`; [interpret the score](quality-and-goals.md#quality-scoring).
- **Prepare a branch for delivery:** [run `ship`](pipelines.md#built-in-pipelines), [publish the PR](safety.md#publishing-a-run), then [close the worktree](worktrees.md#closing-a-worktree-convoy-close).
- **Resume interrupted work:** [open the run history](running.md#usage) or use `convoy --resume <run-id>`.
- **Change models or instructions:** [edit configuration](configuration.md#editing-config-interactively-convoy-config), [route models](models.md#model-gateways), or [override an agent prompt](configuration.md#overriding-an-agent-prompt-convoy-agents-eject).

The [development guide](development.md) covers the source layout and checks. Design plans in `docs/plans/` are development records, not the user guide.
