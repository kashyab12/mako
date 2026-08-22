import { COMMIT_PROMPT, type AgentHost } from "../host.js"
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
  registerIpc("mako:git-diff-all", () =>
    withHost((host) => host.gitDiffAll())
  )
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
  registerIpc(
    "mako:git-generate-message",
    (_event, options?: { prompt?: string; model?: string }) =>
      withHost((host) => host.generateCommitMessage(options))
  )
  registerIpc("mako:default-commit-prompt", () => COMMIT_PROMPT)
}
