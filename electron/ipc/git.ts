import { app, safeStorage } from "electron"
import { join } from "node:path"
import { COMMIT_PROMPT, type AgentHost } from "../host.js"
import { hostClient } from "../host-client.js"
import { CommitGeneration } from "../commit-generation.js"
import { UtilityModelStore } from "../utility-model-store.js"
import { UtilityModelCatalog } from "../utility-model-catalog.js"
import type {
  CommitGenerationInput,
  UtilityCatalogInput,
  UtilityConnectionInput,
  UtilityProvider,
} from "../shared.js"
import { registerIpc } from "./register.js"

export interface GitIpcContext {
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
}

export function installGitIpc(context: GitIpcContext): void {
  const { withHost } = context
  registerIpc("mako:git-status", () => withHost((host) => host.gitStatus()))
  registerIpc("mako:git-diff", (_event, path: string) =>
    withHost((host) => host.gitDiff(path))
  )
  registerIpc("mako:git-diff-all", () => withHost((host) => host.gitDiffAll()))
  registerIpc("mako:git-stage", (_event, paths: string[]) =>
    withHost((host) => host.gitStage(paths))
  )
  registerIpc("mako:git-unstage", (_event, paths: string[]) =>
    withHost((host) => host.gitUnstage(paths))
  )
  registerIpc("mako:git-stage-all", () =>
    withHost((host) => host.gitStageAll())
  )
  registerIpc("mako:git-unstage-all", () =>
    withHost((host) => host.gitUnstageAll())
  )
  registerIpc(
    "mako:git-commit",
    (_event, message: string, options?: { amend?: boolean }) =>
      withHost((host) => host.gitCommit(message, options))
  )
  registerIpc("mako:git-push", () => withHost((host) => host.gitPush()))
  registerIpc("mako:git-log", (_event, limit?: number) =>
    withHost((host) => host.gitLog(limit))
  )
  registerIpc("mako:git-commit-files", (_event, hash: string) =>
    withHost((host) => host.gitCommitFiles(hash))
  )
  registerIpc(
    "mako:git-commit-file-diff",
    (_event, hash: string, path: string) =>
      withHost((host) => host.gitCommitFileDiff(hash, path))
  )
  registerIpc("mako:git-commit-diff-all", (_event, hash: string) =>
    withHost((host) => host.gitCommitDiffAll(hash))
  )
  const models = new UtilityModelStore(
    join(app.getPath("userData"), "utility-models"),
    {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" ||
          safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    }
  )
  const generation = new CommitGeneration(models)
  const catalog = new UtilityModelCatalog(models)
  registerIpc("mako:utility-model-settings", () => models.settings())
  registerIpc(
    "mako:utility-model-catalog",
    (_event, input: UtilityCatalogInput) => catalog.list(input)
  )
  registerIpc(
    "mako:utility-model-connect",
    (_event, input: UtilityConnectionInput) => models.connect(input)
  )
  registerIpc(
    "mako:utility-model-disconnect",
    (_event, provider: UtilityProvider) => models.disconnect(provider)
  )
  registerIpc("mako:git-cancel-generation", (_event, requestId: string) =>
    generation.cancel(hostClient(), requestId)
  )
  registerIpc(
    "mako:git-generate-message",
    (_event, input: CommitGenerationInput) =>
      withHost((host) => {
        if (host.workspace !== input.cwd)
          throw new Error(
            "The workspace changed. Refresh Changes before drafting a message."
          )
        return generation.generate(hostClient(), input)
      })
  )
  registerIpc("mako:default-commit-prompt", () => COMMIT_PROMPT)
}
