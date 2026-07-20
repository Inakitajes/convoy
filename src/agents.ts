import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { bashPolicy, noAdditions } from "./bash-policy"
import { builtInPrompts } from "./built-in-prompts"
import { builtInAgents, readOnlyAgentSuffix } from "./pipeline"
import type { AgentSpec, PermissionAdditions } from "./types"
import { globalAgentsDir } from "./workspace"

const runtimeSafetyPrompt = "runtime-safety"

export function opencodeConfig(
  runDir: string,
  targetDir = process.cwd(),
  agents: readonly AgentSpec[] = builtInAgents,
  permissions: PermissionAdditions = noAdditions,
): Config {
  const agent: Record<string, AgentConfig> = {}
  for (const spec of agents) {
    // Synthesized forced-read-only variants (name suffixed "__ro", see
    // synthesizeReadOnlyAgents in pipeline.ts) have no prompt file of their
    // own; they share the base agent's prompt under its real name.
    const promptName = spec.name.endsWith(readOnlyAgentSuffix) ? spec.name.slice(0, -readOnlyAgentSuffix.length) : spec.name
    agent[spec.name] = agentConfig(spec.description, spec.temperature, spec.readOnly, loadAgentPrompt(promptName, targetDir), runDir, targetDir, false, permissions)
  }

  return {
    agent,
    provider: providerTimeouts(),
    permission: {
      question: "deny",
    },
  }
}

export function loadAgentPrompt(agentName: string, targetDir = process.cwd()) {
  // Precedence mirrors config merge: project override > global override > built-in.
  const agentPrompt = readProjectAgentPrompt(agentName, targetDir) ?? readGlobalAgentPrompt(agentName) ?? readBuiltInPrompt(agentName)
  const safetyPrompt = readBuiltInPrompt(runtimeSafetyPrompt)
  return [agentPrompt.trimEnd(), "", "---", "", safetyPrompt.trim()].join("\n")
}

export function projectAgentPromptPath(agentName: string, targetDir: string) {
  return join(targetDir, ".convoy", "agents", `${agentName}.md`)
}

function readProjectAgentPrompt(agentName: string, targetDir: string) {
  const path = projectAgentPromptPath(agentName, targetDir)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readGlobalAgentPrompt(agentName: string) {
  const path = join(globalAgentsDir(), `${agentName}.md`)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readBuiltInPrompt(promptName: string) {
  const prompt = builtInPrompts[promptName]
  if (prompt !== undefined) return prompt
  if (builtInAgents.some((agent) => agent.name === promptName) || promptName === runtimeSafetyPrompt) {
    throw new Error(`missing built-in prompt: add prompts/${promptName}.md to src/built-in-prompts.ts`)
  }
  throw new Error(`agent "${promptName}" has no prompt; create .convoy/agents/${promptName}.md in the target repo`)
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const providerIdleTimeoutMs = 10 * 60 * 1000

function providerTimeouts(): Config["provider"] {
  const options = {
    timeout: false as const,
    chunkTimeout: providerIdleTimeoutMs,
  }

  return {
    anthropic: { options },
    openai: { options },
    openrouter: { options },
    vercel: { options },
  }
}

function agentConfig(
  description: string,
  temperature: number | undefined,
  readOnly: boolean | undefined,
  prompt: string,
  runDir: string,
  targetDir: string,
  webfetch: boolean,
  permissions: PermissionAdditions,
): AgentConfig {
  if (readOnly) {
    return {
      description,
      mode: "primary",
      ...(temperature === undefined ? {} : { temperature }),
      tools: {
        read: true,
        list: true,
        glob: true,
        grep: true,
        write: false,
        edit: false,
        bash: false,
        task: false,
        webfetch,
        websearch: false,
      },
      permission: {
        read: "allow",
        list: "allow",
        glob: "allow",
        grep: "allow",
        edit: "deny",
        bash: "deny",
        task: "deny",
        question: "deny",
        webfetch: webfetch ? "allow" : "deny",
        websearch: "deny",
        external_directory: {
          "*": "deny",
          [join(runDir, "**")]: "allow",
        },
      },
      prompt,
    }
  }

  return {
    description,
    mode: "primary",
    ...(temperature === undefined ? {} : { temperature }),
    tools: {
      read: true,
      write: true,
      edit: true,
      bash: true,
      webfetch,
    },
    permission: {
      edit: "allow",
      question: "deny",
      bash: bashPolicy(targetDir, permissions),
      external_directory: {
        "*": "deny",
        [join(runDir, "**")]: "allow",
      },
    },
    prompt,
  }
}
