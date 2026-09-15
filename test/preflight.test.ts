import { describe, expect, test, mock } from "bun:test"

import { preflightTargets, validatePreflightTargets } from "../src/preflight-validation"
import { preflightRunPlan, withinPreflightTimeout } from "../src/preflight"
import type { ResolvedModel } from "../src/model-routing"
import type { RunPlan } from "../src/types"

function plan(): RunPlan {
  return {
    prompt: { source: "inline", text: "ship it" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "implement",
      steps: [
        {
          type: "agent",
          name: "implementer",
          stepName: "implementer",
          groupId: "g1",
          agentName: "implementer",
          description: "Implements",
          model: "vercel/openai/gpt-5.6-sol",
          resolvedModel: {
            configured: "openai/gpt-5.6-sol",
            logical: "openai/gpt-5.6-sol",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-5.6-sol",
            target: "vercel/openai/gpt-5.6-sol",
          },
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/implementer.md",
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
  }
}

function directOpenAIPlan(): RunPlan {
  const result = plan()
  const step = result.pipeline.steps[0]!
  if (step.type !== "agent") throw new Error("expected agent step")
  step.model = "openai/gpt-5.6-terra"
  step.variant = "xhigh"
  step.resolvedModel = {
    configured: "openai/gpt-5.6-terra#xhigh",
    logical: "openai/gpt-5.6-terra#xhigh",
    gateway: "configured",
    providerID: "openai",
    modelID: "gpt-5.6-terra",
    variant: "xhigh",
    target: "openai/gpt-5.6-terra#xhigh",
  }
  result.modelRouting.gateway = "configured"
  return result
}

// A nitro plan frozen by a pre-throughput Convoy version: its targets still
// carry the literal `:nitro` suffix the catalog can never resolve directly.
function nitroPlan(): RunPlan {
  const result = plan()
  const step = result.pipeline.steps[0]!
  if (step.type !== "agent") throw new Error("expected agent step")
  step.model = "openrouter/z-ai/glm-5.2:nitro"
  step.variant = "xhigh"
  step.resolvedModel = {
    configured: "zai/glm-5.2#xhigh",
    logical: "zai/glm-5.2#xhigh",
    gateway: "nitro",
    providerID: "openrouter",
    modelID: "z-ai/glm-5.2:nitro",
    variant: "xhigh",
    target: "openrouter/z-ai/glm-5.2:nitro#xhigh",
  }
  result.modelRouting.gateway = "nitro"
  return result
}

/** A goal plan whose improve-only step routes to a distinct model (gpt-5.6-terra). */
function goalPlan(): RunPlan {
  const result = plan()
  const prefix = result.pipeline.steps[0]!
  if (prefix.type !== "agent") throw new Error("expected agent step")
  const improveModel: ResolvedModel = {
    configured: "openai/gpt-5.6-terra#xhigh",
    logical: "openai/gpt-5.6-terra#xhigh",
    gateway: "configured",
    providerID: "openai",
    modelID: "gpt-5.6-terra",
    variant: "xhigh",
    target: "openai/gpt-5.6-terra#xhigh",
  }
  result.goal = {
    target: 85,
    maxIterations: 3,
    plateau: 3,
    briefRecipient: "fix",
    scoreProducer: "arbiter",
    improve: {
      steps: [
        {
          ...prefix,
          name: "fix",
          stepName: "fix",
          agentName: "goal-fixer",
          groupId: "improve-g1",
          model: "openai/gpt-5.6-terra#xhigh",
          resolvedModel: improveModel,
        },
      ],
    },
    measure: {
      steps: [
        { ...prefix, name: "arbiter", stepName: "arbiter", groupId: "measure-g1", readOnly: true, reportPath: "reports/arbiter.md" },
      ],
    },
  }
  return result
}

function nitroCatalog(input: { hasUnsuffixed?: boolean; onlySuffixed?: boolean; variants?: string[]; connected?: boolean } = {}) {
  const models: Record<string, { variants: Record<string, unknown> }> = {}
  if (input.hasUnsuffixed !== false) models["z-ai/glm-5.2"] = { variants: Object.fromEntries((input.variants ?? ["xhigh"]).map((variant) => [variant, {}])) }
  if (input.onlySuffixed) {
    delete models["z-ai/glm-5.2"]
    models["z-ai/glm-5.2:nitro"] = { variants: Object.fromEntries((input.variants ?? ["xhigh"]).map((variant) => [variant, {}])) }
  }
  return {
    all: [{ id: "openrouter", models }],
    connected: input.connected === false ? [] : ["openrouter"],
  }
}

function catalog(input: { providerID?: string; connected?: boolean; modelID?: string; variants?: string[] } = {}) {
  const providerID = input.providerID ?? "vercel"
  const modelID = input.modelID ?? "openai/gpt-5.6-sol"
  return {
    all: [
      {
        id: providerID,
        models: {
          [modelID]: { variants: Object.fromEntries((input.variants ?? []).map((variant) => [variant, {}])) },
        },
      },
    ],
    connected: input.connected === false ? [] : [providerID],
  }
}

function noopDiscover() {
  return Promise.resolve(catalog())
}

describe("OpenCode run-plan preflight", () => {
  test("collects OpenCode steps, smart judge, and branch namer targets — never Claude Code", () => {
    const reviewed = plan()
    reviewed.pipeline.steps.push({
      type: "agent",
      name: "external-audit",
      stepName: "external-audit",
      groupId: "g2",
      agentName: "external-audit",
      description: "External audit",
      runner: "claude-code",
      model: "opus",
      inputFiles: ["prd.md"],
      inputDiff: false,
      reportPath: "reports/external-audit.md",
      readOnly: true,
    })
    reviewed.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku-4.5",
        logical: "anthropic/claude-haiku-4.5",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4.5",
        target: "vercel/anthropic/claude-haiku-4.5",
      },
    }
    reviewed.target = { ...reviewed.target, worktree: true, branch: "feat/add-onboarding" }

    expect(preflightTargets(reviewed).map((target) => target.target)).toEqual([
      "vercel/openai/gpt-5.6-sol",
      "vercel/anthropic/claude-haiku-4.5",
    ])
  })

  test("accepts connected providers and exact physical model IDs", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog())).not.toThrow()
  })

  test("accepts the classic connected OpenAI catalog used by session.prompt", () => {
    expect(() =>
      validatePreflightTargets(
        preflightTargets(directOpenAIPlan()),
        catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] }),
      ),
    ).not.toThrow()
  })

  test("preflights the resolved run against classic discovery in its target directory", async () => {
    const reviewed = directOpenAIPlan()
    let discoveredDirectory: string | undefined

    await preflightRunPlan(reviewed, async (directory) => {
      discoveredDirectory = directory
      return catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] })
    })

    expect(discoveredDirectory).toBe("/repo")
  })

  test("returns early when the plan has no preflight targets", async () => {
    const reviewed = plan()
    reviewed.pipeline.steps = []
    let discoverCalled = false

    await preflightRunPlan(reviewed, async () => {
      discoverCalled = true
      return catalog()
    })

    expect(discoverCalled).toBe(false)
  })

  test("returns early when the plan only has claude-code steps", async () => {
    const reviewed = plan()
    reviewed.pipeline.steps[0] = {
      ...reviewed.pipeline.steps[0],
      runner: "claude-code",
      model: "opus",
      resolvedModel: undefined,
    } as typeof reviewed.pipeline.steps[0]
    let discoverCalled = false

    await preflightRunPlan(reviewed, async () => {
      discoverCalled = true
      return catalog()
    })

    expect(discoverCalled).toBe(false)
  })

  test("throws when a provider is not connected", async () => {
    const reviewed = plan()

    await expect(preflightRunPlan(reviewed, async () => catalog({ connected: false }))).rejects.toThrow(
      "Missing provider credentials",
    )
  })

  test("throws when a model is not found in the catalog", async () => {
    const reviewed = plan()

    await expect(
      preflightRunPlan(reviewed, async () => catalog({ modelID: "some-other-model" })),
    ).rejects.toThrow("Model unavailable")
  })

  test("throws when a variant is not found in the catalog", async () => {
    const reviewed = directOpenAIPlan()

    await expect(
      preflightRunPlan(
        reviewed,
        async () => catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["high"] }),
      ),
    ).rejects.toThrow("Model unavailable")
  })

  test("preflights every goal-fragment model and advisor once with the prefix", () => {
    // The improve and measure fragments are part of the reviewed plan: models
    // that would only run in a later iteration still reject the parent plan
    // before any phase starts.
    const reviewed = goalPlan()
    expect(preflightTargets(reviewed).map((target) => target.target)).toEqual([
      "vercel/openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra#xhigh",
      "vercel/openai/gpt-5.6-sol",
    ])
  })

  test("rejects a goal-improve-only model that is unavailable up front", async () => {
    const reviewed = goalPlan()

    // The catalog serves the prefix and measure models but not the improve
    // step's: the run must refuse before the prefix is paid for, because the
    // improvement would only surface later.
    await expect(
      preflightRunPlan(
        reviewed,
        async () => ({
          all: [
            { id: "vercel", models: { "openai/gpt-5.6-sol": { variants: {} } } },
            { id: "openai", models: { "gpt-5.6-sol": { variants: {} } } },
          ],
          connected: ["vercel", "openai"],
        }),
      ),
    ).rejects.toThrow("Model unavailable")
  })

  test("throws when the discover function rejects", async () => {
    const reviewed = plan()

    await expect(
      preflightRunPlan(reviewed, async () => {
        throw new Error("network error")
      }),
    ).rejects.toThrow("network error")
  })

  test("throws when the catalog is missing the provider entry entirely", async () => {
    const reviewed = directOpenAIPlan()

    await expect(
      preflightRunPlan(reviewed, async () => ({
        all: [],
        connected: [],
      })),
    ).rejects.toThrow("Model unavailable")
  })

  test("reports Vercel authentication guidance when it is not connected", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "Missing provider credentials: vercel",
    )
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("reports unavailable variants from the exact classic model catalog", () => {
    expect(() =>
      validatePreflightTargets(preflightTargets(directOpenAIPlan()), catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["high"] })),
    ).toThrow("Model unavailable")
  })

  test("reports the logical and exact physical target when a model is unavailable", () => {
    const targets = preflightTargets(plan())
    const withoutTarget = catalog({ modelID: "some-other-model" })

    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("Model unavailable through Vercel AI Gateway")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("logical: openai/gpt-5.6-sol")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("target:  vercel/openai/gpt-5.6-sol")
  })

  test("nitro preflight looks up the unsuffixed catalog model", () => {
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog())).not.toThrow()
  })

  test("nitro preflight fails when the unsuffixed catalog model is missing", () => {
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ hasUnsuffixed: false }))).toThrow(
      "Model unavailable through OpenRouter Nitro",
    )
  })

  test("nitro preflight never looks up the suffixed catalog key", () => {
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ onlySuffixed: true }))).toThrow(
      "Model unavailable",
    )
  })

  test("nitro failure reports the full suffixed physical target", () => {
    const withoutTarget = nitroCatalog({ hasUnsuffixed: false })
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), withoutTarget)).toThrow(
      "Model unavailable through OpenRouter Nitro",
    )
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), withoutTarget)).toThrow("logical: zai/glm-5.2#xhigh")
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), withoutTarget)).toThrow("target:  openrouter/z-ai/glm-5.2:nitro#xhigh")
  })

  test("nitro variant checks run against the unsuffixed catalog entry", () => {
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ variants: ["high"] }))).toThrow(
      "Model unavailable",
    )
  })

  test("missing openrouter credentials use the generic login hint, not the Vercel key", () => {
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ connected: false }))).toThrow(
      "Missing provider credentials: openrouter",
    )
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ connected: false }))).toThrow(
      "opencode providers login",
    )
    expect(() => validatePreflightTargets(preflightTargets(nitroPlan()), nitroCatalog({ connected: false }))).not.toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("a configured target with a :nitro modelID still preflights the unsuffixed catalog ID", () => {
    const reviewed = nitroPlan()
    const step = reviewed.pipeline.steps[0]!
    if (step.type !== "agent") throw new Error("expected agent step")
    step.resolvedModel = {
      configured: "openrouter/z-ai/glm-5.2:nitro#xhigh",
      logical: "zai/glm-5.2#xhigh",
      gateway: "configured",
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2:nitro",
      variant: "xhigh",
      target: "openrouter/z-ai/glm-5.2:nitro#xhigh",
    }
    reviewed.modelRouting.gateway = "configured"

    expect(() => validatePreflightTargets(preflightTargets(reviewed), nitroCatalog())).not.toThrow()
    expect(() => validatePreflightTargets(preflightTargets(reviewed), nitroCatalog({ hasUnsuffixed: false }))).toThrow(
      "Model unavailable",
    )
  })

  test("a fresh nitro plan preflights the plain OpenRouter target", () => {
    const fresh = nitroPlan()
    const step = fresh.pipeline.steps[0]!
    if (step.type !== "agent") throw new Error("expected agent step")
    step.model = "openrouter/z-ai/glm-5.2"
    step.resolvedModel = {
      configured: "zai/glm-5.2#xhigh",
      logical: "zai/glm-5.2#xhigh",
      gateway: "nitro",
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2",
      variant: "xhigh",
      target: "openrouter/z-ai/glm-5.2#xhigh",
    }

    expect(() => validatePreflightTargets(preflightTargets(fresh), nitroCatalog())).not.toThrow()
    expect(() => validatePreflightTargets(preflightTargets(fresh), nitroCatalog({ hasUnsuffixed: false }))).toThrow(
      "Model unavailable",
    )
    expect(() => validatePreflightTargets(preflightTargets(fresh), nitroCatalog({ hasUnsuffixed: false }))).toThrow(
      "target:  openrouter/z-ai/glm-5.2#xhigh",
    )
  })
})

describe("withinPreflightTimeout edge cases (through preflightRunPlan)", () => {
  test("rejects immediately when AbortSignal.timeout fires (race condition)", async () => {
    const reviewed = plan()
    const originalTimeout = AbortSignal.timeout
    const abortedSignal = AbortSignal.abort()
    AbortSignal.timeout = mock(() => abortedSignal) as unknown as typeof AbortSignal.timeout
    try {
      await expect(
        preflightRunPlan(reviewed, async () => {
          await new Promise(() => {})
          return catalog()
        }),
      ).rejects.toThrow("OpenCode preflight timed out")
    } finally {
      AbortSignal.timeout = originalTimeout
    }
  })

  test("resolves with valid discover", async () => {
    const reviewed = plan()
    const discover = mock(() => Promise.resolve(catalog()))
    await expect(preflightRunPlan(reviewed, discover)).resolves.toBeUndefined()
    expect(discover).toHaveBeenCalled()
  })

  test("rejects when discover promise rejects", async () => {
    const reviewed = plan()
    await expect(
      preflightRunPlan(reviewed, async () => {
        throw new Error("discovery failure")
      }),
    ).rejects.toThrow("discovery failure")
  })
})
describe("withinPreflightTimeout cleanup ownership (design D2)", () => {
  test("awaits the cancel hook before the timeout rejection settles", async () => {
    const controller = new AbortController()
    let cancelled = false
    const settled = withinPreflightTimeout(new Promise<never>(() => {}), controller.signal, async () => {
      await Bun.sleep(20)
      cancelled = true
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    controller.abort()
    expect(await settled).toBe("OpenCode preflight timed out")
    // The caller never returns ahead of the bounded owned-server stop.
    expect(cancelled).toBe(true)
  })

  test("never waits for the original request to settle", async () => {
    const controller = new AbortController()
    const pending = withinPreflightTimeout(new Promise<never>(() => {}), controller.signal, async () => {})
    controller.abort()
    await expect(pending).rejects.toThrow("OpenCode preflight timed out")
  })

  test("a failing cancel hook never masks the timeout itself", async () => {
    const controller = new AbortController()
    const pending = withinPreflightTimeout(new Promise<never>(() => {}), controller.signal, async () => {
      throw new Error("cancel exploded")
    })
    controller.abort()
    await expect(pending).rejects.toThrow("OpenCode preflight timed out")
  })
})
