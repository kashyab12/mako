import { z } from "zod"
import type { CommitGenerationInput, CommitGenerationResult } from "./shared.js"
import { UtilityModelError, utilityLanguageModel, utilityProviders } from "./utility-models.js"
import type { UtilityModelStore } from "./utility-model-store.js"
import { KiriCommitEngine } from "./kiri-commit.js"
import { utilityTokenCounter } from "./utility-token-count.js"

const inputSchema = z.object({ mode: z.enum(["fast", "deep"]).default("fast"), requestId: z.string().uuid(), cwd: z.string().min(1).max(4_096), prompt: z.string().max(12_000).optional(), model: z.string().max(400).optional() })

export class CommitGeneration {
  private readonly active = new Map<string, { id: string; controller: AbortController }>()
  private readonly models: UtilityModelStore
  private readonly engine: KiriCommitEngine
  constructor(models: UtilityModelStore, engine = new KiriCommitEngine()) {
    this.models = models
    this.engine = engine
  }

  async generate(client: string, input: CommitGenerationInput): Promise<CommitGenerationResult> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new Error("Invalid commit-generation request. Keep custom instructions under 12,000 characters.")
    if (this.active.has(client)) throw new Error("A commit message is already being generated in this window.")
    const request = parsed.data
    const controller = new AbortController()
    this.active.set(client, { id: request.requestId, controller })
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    try {
      const provider = utilityProviders.find(({ id }) => request.model?.startsWith(`${id}/`))
      if (!provider) throw new Error("Connect a model in Settings > Commit messages, then choose it for drafting.")
      const connection = await this.models.load(provider.id)
      if (!connection || `${connection.provider}/${connection.model}` !== request.model) throw new Error("The selected model connection has changed. Choose a connected model in Settings > Commit messages.")
      return await this.engine.generate({ client, cwd: request.cwd, mode: request.mode, model: utilityLanguageModel(connection, connection.apiKey), connection, prompt: request.prompt, countTokens: utilityTokenCounter(connection, connection.apiKey), signal })
    } catch (error) {
      if (signal.aborted) throw new UtilityModelError("timeout", controller.signal.aborted ? "Generation cancelled." : "Generation timed out. Completed analysis can be reused on retry.")
      throw error
    } finally {
      if (this.active.get(client)?.controller === controller) this.active.delete(client)
    }
  }
  cancel(client: string, requestId: string): void {
    const request = this.active.get(client)
    if (request?.id === requestId) { request.controller.abort(); this.active.delete(client) }
  }
  commit(client: string, cwd: string, message: string): Promise<void> { return this.engine.commit(client, cwd, message) }
}
