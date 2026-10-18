# Claude native facility evidence (task 1.4)

What the installed Claude CLI (tested `2.1.296`) and the official docs actually
expose for the facilities our design treats as optional mechanisms. This decides
whether we reuse a native facility or keep our own Convoy integration, and stops
us from claiming two differently-shaped mechanisms are equivalent.

Rule (design D8/D10): a native facility satisfies a Convoy requirement only after
tests demonstrate the same routing, enforcement, context scope, limits, and
attribution. A feature name is not evidence.

## Native advisor

| Aspect | Finding | Evidence |
|---|---|---|
| Flag exists | `--advisor <model>` is documented; not listed in `claude --help` (the CLI does not list every flag). | Official CLI reference; `claude --help` (no match). |
| Routing | Sets a specific advisor model for the session; `advisorModel` setting fallback. | Docs |
| Checkpoint enforcement | No documented pre-write blocking hook tied to the advisor. It advises; it does not gate a write. | Docs |
| Context scope / limits | Docs do not expose a bounded context snapshot or call/output caps per consultation. | Docs |
| Attribution | Advisor consumption is not separately accounted from an unexplained executor total. | Docs |

**Verdict:** `native support, not equivalent`. Convoy keeps its own advisor bridge
(design D8) for mandatory checkpoints, context bounds, call/output limits, and
per-attempt attribution. `--advisor` may be offered later only after equivalence
tests; it must not replace the checkpoint mechanism.

## Native live attach / handoff / background

| Aspect | Finding | Evidence |
|---|---|---|
| Background sessions | `claude --bg` starts a background session and returns immediately; `claude attach <id>`, `logs`, `stop`, `rm` manage it. | `claude --help` subcommands; docs |
| Print vs background | `--bg` cannot combine with `-p`/`--print`. | Docs; `--help` |
| Resume running session | `--resume <id>` on a still-running background session attaches to it. | Docs |
| Writer safety | Attaching/`--bg` says nothing about whether another writer holds the checkout. | Docs |

**Verdict:** `native support present, semantics differ from Convoy's quiesced handoff`.
Convoy's handoff requires quiescing the prior writer and transferring the managed
writer claim before a second writer starts (design D10). A raw `claude attach`
does not provide that guarantee, so it cannot be used as an unattended handoff.

## What we will not do

- Do not run `--bg` under `-p` (rejected).
- Do not use `--bare` for subscription runs (bare mode does not use subscription login).
- Do not treat `--advisor` or `claude attach` as parity without the equivalence
  tests named in design D8/D10.
- Do not extract credentials or drive subscription traffic through the Agent SDK.

## Classification (design D4 advanced-interaction row)

| Facility | Classification |
|---|---|
| Native advisor | Account/version-restricted native mechanism; **not** Convoy-equivalent |
| Background session + attach | Native mechanism; usable only behind a verified quiesced-handoff contract |
| Post-exit `--resume` | Supported exact-session resume; already the hackathon baseline |

## Status

Evidence gathered from official documentation and the installed CLI (no model
calls, no spend). The "supported equivalent" classification for a quiesced
handoff and any use of `--advisor` remain **unverified** until group 6/11 receives
consented real-harness evidence.
