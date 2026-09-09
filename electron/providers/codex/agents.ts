import { z } from "zod"
import type { ThreadItem } from "./generated/v2/ThreadItem.js"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

export const CodexAgentItemSchema = z.object({
  type: z.literal("collabAgentToolCall"),
  id: z.string(),
  tool: z.enum([
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
  ]),
  status: z.enum(["inProgress", "completed", "failed"]),
  senderThreadId: z.string(),
  receiverThreadIds: z.array(z.string()).max(256),
  prompt: z.string().nullable(),
  model: z.string().nullable(),
  agentsStates: z.record(
    z.string(),
    z
      .object({
        status: z.enum([
          "pendingInit",
          "running",
          "interrupted",
          "completed",
          "errored",
          "shutdown",
          "notFound",
        ]),
        message: z.string().nullable(),
      })
      .optional()
  ),
}) satisfies z.ZodType<
  Omit<Extract<ThreadItem, { type: "collabAgentToolCall" }>, "reasoningEffort">
>
export const CodexAgentActivitySchema = z.object({
  type: z.literal("subAgentActivity"),
  id: z.string(),
  kind: z.enum(["started", "interacted", "interrupted"]),
  agentThreadId: z.string(),
  agentPath: z.string(),
}) satisfies z.ZodType<Extract<ThreadItem, { type: "subAgentActivity" }>>
export type CodexAgentItem =
  | z.infer<typeof CodexAgentItemSchema>
  | z.infer<typeof CodexAgentActivitySchema>

function nativeState(
  state: NonNullable<
    z.infer<typeof CodexAgentItemSchema>["agentsStates"][string]
  >
): NativeAgentObservation["state"] {
  const message = state.message?.slice(0, 8192)
  switch (state.status) {
    case "pendingInit":
      return { kind: "waiting", reason: "Starting agent" }
    case "running":
      return { kind: "working", activity: message }
    case "completed":
      return { kind: "completed", summary: message }
    case "errored":
      return { kind: "failed", error: message ?? "Agent failed" }
    case "interrupted":
    case "shutdown":
      return { kind: "canceled" }
    case "notFound":
      return { kind: "unknown", reason: "Provider could not find this agent" }
  }
}

export class CodexAgents {
  private readonly agents = new Map<string, NativeAgentObservation>()
  project(item: CodexAgentItem, replay: boolean): NativeAgentObservation[] {
    const updates = new Map<string, NativeAgentObservation>()
    const add = (agent: NativeAgentObservation) => {
      const observed: NativeAgentObservation =
        replay &&
        (agent.state.kind === "working" || agent.state.kind === "waiting")
          ? {
              ...agent,
              state: {
                kind: "unknown",
                reason:
                  "Historical agent status; current activity is not confirmed.",
              },
            }
          : agent
      this.agents.set(agent.nativeId, observed)
      updates.set(agent.nativeId, observed)
    }
    if (item.type === "subAgentActivity") {
      if (item.kind === "interacted") return []
      const previous = this.agents.get(item.agentThreadId)
      add({
        ...previous,
        nativeId: item.agentThreadId,
        title: previous?.title ?? item.agentPath.slice(0, 512),
        toolId: previous?.toolId ?? item.id,
        state:
          item.kind === "started" ? { kind: "working" } : { kind: "canceled" },
      })
    } else {
      if (item.tool === "spawnAgent" || item.tool === "resumeAgent") {
        for (const nativeId of item.receiverThreadIds) {
          const previous = this.agents.get(nativeId)
          add({
            ...previous,
            nativeId,
            parentNativeId: item.senderThreadId,
            title: previous?.title ?? item.prompt?.slice(0, 512) ?? "Agent",
            model: item.model?.slice(0, 256) ?? previous?.model,
            toolId: previous?.toolId ?? item.id,
            state:
              item.status === "failed"
                ? { kind: "failed", error: "Agent launch failed" }
                : { kind: "working" },
          })
        }
      }
      for (const [nativeId, state] of Object.entries(item.agentsStates).slice(
        0,
        256
      )) {
        if (!state) continue
        const previous = this.agents.get(nativeId)
        add({
          ...previous,
          nativeId,
          title: previous?.title ?? "Agent",
          parentNativeId: previous?.parentNativeId ?? item.senderThreadId,
          state: nativeState(state),
        })
      }
    }
    while (this.agents.size > 1024) {
      const oldest = this.agents.keys().next().value
      if (!oldest) break
      this.agents.delete(oldest)
    }
    return [...updates.values()]
  }
}
