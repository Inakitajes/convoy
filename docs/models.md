# Models and providers

[Documentation](README.md) · [Convoy](../README.md)

Authenticate providers and route executor and advisor models through gateways.

- [Authentication And Providers](#authentication-and-providers)
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

To use different providers, authenticate them in OpenCode and select models as `provider/model`. The default `full-cycle` uses OpenRouter for DeepSeek, GLM and Grok, and OpenAI for Astra and Sol. `implement` uses the same writing models, with advice only on implementation and a closing DeepSeek recap. See the [default pipeline](pipelines.md#the-default-pipeline-full-cycle) for the step-by-step model choices.

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
