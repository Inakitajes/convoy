# Models and providers

[Documentation](README.md) · [Convoy](../README.md)

Authenticate providers and route executor and advisor models through gateways.

- [Authentication And Providers](#authentication-and-providers)
- [Runner authentication and billing](#runner-authentication-and-billing)
- [Model gateways](#model-gateways)

## Authentication And Providers

Convoy does not store provider credentials. It starts `opencode serve` through the SDK and passes only runtime agent configuration via `OPENCODE_CONFIG_CONTENT`; the server inherits your shell environment and uses the credentials already configured in OpenCode.

Useful commands:

```bash
opencode providers list
opencode providers login --provider openai
opencode providers login --provider anthropic
opencode models openai
opencode models anthropic
```

To use different providers, authenticate them in OpenCode and select models as `provider/model`. The default `full-cycle` uses OpenRouter for DeepSeek, GLM and Grok, and OpenAI for Astra. `implement` uses the same writing models, with advice only on implementation and a closing DeepSeek recap. See the [default pipeline](pipelines.md#the-default-pipeline-full-cycle) for the step-by-step model choices.

## Runner authentication and billing

**OpenCode** requires a supported OpenCode V2 on `PATH`; Convoy never installs,
updates, or replaces it. **Claude** uses the operator's authenticated `claude`
CLI, and **Codex** the operator's authenticated `codex` CLI. Authentication and
billing are **separate**: subscription login does not guarantee included-only
usage, and Convoy never changes account spending settings. See
[Runners](runners.md) for execution modes, reports, advisors, dashboards, and
recovery, and for [writing one model for any runner](runners.md#models-one-spelling-any-runner).

### Subscription setup

Sign in once with each CLI's own supported login flow (`claude`, then
`/login`; `codex login`); Convoy never reads credential stores, extracts
tokens, or automates login. A CLI runner defaults to `subscription`; state the
billing decision explicitly so unattended launches can run too:

```yaml
version: 1
runners:
  claude-code:
    auth:
      billingPolicy: account-policy   # usage credits or paid features may apply
  codex:
    auth:
      billingPolicy: account-policy
```

A subscription-only configuration requires no API key and no OpenCode
installation. Neither CLI exposes a control that enforces included-only usage,
so `billingPolicy: included-only` is refused at preflight rather than
promised. Without a `billingPolicy`, the launch review discloses the account
policy and confirming it is the consent; an unattended launch must configure
it. Convoy never enables extra usage, buys credits, or raises provider-side
spend limits.

### API-key opt-in

API-key execution is a separate, explicit mode. Reference an environment
variable by name; never put the key itself in the file:

```yaml
version: 1
runners:
  claude-code:
    auth:
      authMode: api-key
      credentialRef: CONVOY_ANTHROPIC_KEY   # the variable that holds the key
  codex:
    auth:
      authMode: api-key
      credentialRef: CONVOY_OPENAI_KEY
```

```bash
export CONVOY_ANTHROPIC_KEY=sk-ant-...
export CONVOY_OPENAI_KEY=sk-...
```

Convoy uses the key only for the child, so the selected key is the effective
billing source: Claude gets it in its environment with ambient
OAuth/subscription tokens removed; Codex logs it in to a private, per-use Codex
home that is discarded afterwards, leaving the operator's own Codex login
untouched. Run metadata records the mode and the variable name, never the
value.

### Legacy configuration migration

Older configurations declare `runner: claude-code` steps with no runner auth.
They run as `subscription`, and preflight verifies that claim with
`claude auth status --json` under the child's overlay before any work starts:
when Claude would actually bill an API key, a key helper, or a third-party
provider, the launch is refused with guidance to set `runners.claude-code.auth`
explicitly. `defaults.claudeAuth`, the older spelling, still reads when
`runners.claude-code.auth` is unset. Convoy never infers permission to use API
billing, and existing runner IDs and model strings stay compatible.

### Cost labels

Subscription and API-key figures are labeled differently and never conflated:

| | OpenCode / API key | Claude or Codex subscription |
|---|---|---|
| Monetary value | estimate of provider charges | **estimate only**, not a cash charge |
| Quota | provider-side; not tracked as a guarantee | not a remaining-balance report |
| Missing data | unknown, never zero | unknown, never zero |

Neither column is an invoice. [Runners](runners.md#usage-and-billing) explains
the distinction and gives retry/resume examples. Tested versions are recorded in
`openspec/changes/runner-parity-opencode-v2/evidence/compatibility.md`.

## Model gateways

Convoy can change how every OpenCode model is reached without rewriting a pipeline:

```sh
convoy "Implement the feature" --gateway direct
convoy "Implement the feature" --gateway openrouter
convoy "Implement the feature" --gateway nitro
convoy "Implement the feature" --gateway vercel
convoy "Implement the feature" --gateway configured
```

`configured` (the default) preserves model IDs literally. `direct` uses the model owner's provider; `openrouter` and `vercel` wrap the logical provider/model. Gateways apply to OpenCode only: Claude Code and Codex steps are never rerouted. A `--model` selects the logical model first, then the gateway is applied.

`nitro` is OpenRouter asked to sort providers by **throughput** instead of price — what OpenRouter markets as `:nitro`. The wrap is identical to `openrouter` (same aliases and safety rules, same credential), so the physical IDs look like `openrouter/z-ai/glm-5.2`; the throughput preference itself is expressed the way OpenCode natively supports it: for the duration of the run, Convoy injects `provider.sort: "throughput"` on every OpenRouter model the run uses (executors, advisors, and the smart-mode judge) into that run's OpenCode config. Your global OpenCode config is never touched, so models run with their default routing everywhere else. Nitro often costs more than default OpenRouter routing because it does not load-balance to the cheapest provider; it is meant for long phases where speed matters more than a few cents. The routing preference never becomes part of a model's logical identity, so overrides, vercel/direct conversion, and preflight keep working on the plain ID.

Persist the choice globally in `~/.convoy/config.yaml` or per project in `.convoy/config.yaml` (CLI > project > global > configured):

```yaml
version: 1
modelRouting:
  gateway: vercel
  overrides:
    zai/glm-5.2:
      direct: zai/glm-5.2
      openrouter: openrouter/z-ai/glm-5.2
      vercel: vercel/zai/glm-5.2
```

Unknown model namespaces require an explicit override when rerouting; `configured` always remains literal. Authenticate Vercel through `opencode providers login` (choose Vercel AI Gateway) or set `AI_GATEWAY_API_KEY`; Convoy never stores gateway credentials.

---

[Back to documentation](README.md)
