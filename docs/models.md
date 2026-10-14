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

Runner choice and authentication are explicit selections (tracked in
`openspec/changes/runner-parity-opencode-v2/`; in progress). **OpenCode** is the
shipped runner and requires a supported OpenCode V2 on `PATH`; Convoy never
installs, updates, or replaces it. **Claude** uses the operator's authenticated
`claude` CLI. Authentication and billing are **separate**: subscription login
does not guarantee included-only usage, and Convoy never changes account
spending settings. See [Runners](runners.md) for execution modes, reports,
advisors, and recovery.

### Subscription setup

Sign in once with the CLI's own supported login flow (`claude`, then `/login`);
Convoy never reads credential stores, extracts tokens, or automates login. A new
Claude configuration defaults to `subscription`, and can state it explicitly:

```yaml
version: 1
runners:
  claude-code:
    authMode: subscription
    billingPolicy: included-only   # conservative default
    model: sonnet
```

A subscription-only configuration requires no API key and no OpenCode
installation. `included-only` is honored only when Convoy can verify and enforce
it; when it cannot, preflight asks for an explicit billing decision
(`account-policy`) instead of requiring an API key or implying free usage.
Convoy never enables extra usage, buys credits, or raises provider-side spend
limits.

### API-key opt-in

API-key execution is a separate, explicit mode. Reference an environment
variable by name; never put the key itself in the file:

```yaml
version: 1
runners:
  claude-code:
    authMode: api-key
    credentialRef: CONVOY_ANTHROPIC_KEY   # the variable that holds the key
```

```bash
export CONVOY_ANTHROPIC_KEY=sk-ant-...
```

Convoy sets the key only for the child and removes ambient OAuth/subscription
tokens for it, so the selected key is the effective billing source. Run metadata
records the mode and the variable name, never the value.

### Legacy configuration migration

Older Claude steps declared `runner: claude-code` with no mode. During launch
review an entry with no mode must declare one: Convoy resolves it to
`subscription` only when the effective CLI authentication is a verifiable
subscription, and otherwise refuses to infer permission to spend.

```yaml
# Before: ambiguous — no authentication mode is declared
version: 1
pipelines:
  review:
    steps:
      - agent: security
        runner: claude-code
```

```yaml
# After: declare the mode explicitly (subscription shown)
version: 1
runners:
  claude-code:
    authMode: subscription
pipelines:
  review:
    steps:
      - agent: security
        runner: claude-code
```

A noninteractive run (CI, `--no-tui`) with an ambiguous entry fails with a
migration message asking for `runners.claude-code.authMode`; it never falls back
to an API key. Existing runner IDs and model strings stay compatible.

### Cost labels

Subscription and API-key figures are labeled differently and never conflated:

| | OpenCode / API key | Claude subscription |
|---|---|---|
| Monetary value | estimate of provider charges | **estimate only**, not a cash charge |
| Quota | provider-side; not tracked as a guarantee | not a remaining-balance report |
| Missing data | unknown, never zero | unknown, never zero |

Neither column is an invoice. [Runners](runners.md#usage-and-billing) explains
the distinction and gives retry/resume examples.

Selected versions and the release gate are recorded in that change's
`evidence/compatibility.md` and `design.md`.

## Model gateways

Convoy can change how every OpenCode model is reached without rewriting a pipeline:

```sh
convoy "Implement the feature" --gateway direct
convoy "Implement the feature" --gateway openrouter
convoy "Implement the feature" --gateway nitro
convoy "Implement the feature" --gateway vercel
convoy "Implement the feature" --gateway configured
```

`configured` (the default) preserves model IDs literally. `direct` uses the model owner's provider; `openrouter` and `vercel` wrap the logical provider/model. Claude Code steps are never rerouted. A `--model` selects the logical model first, then the gateway is applied.

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
