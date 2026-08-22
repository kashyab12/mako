import { getMako } from "@/lib/bridge"
import type {
  GitCommitEntry,
  GitDiff,
  GitFileStatus,
} from "@/lib/types"

export interface GitCommitFile {
  path: string
  status: GitFileStatus
  insertions: number
  deletions: number
  binary: boolean
}

export const git = {
  diff(path: string): Promise<GitDiff> {
    return getMako().gitDiff(path)
  },

  diffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return getMako().gitDiffAll()
  },

  commitFileDiff(hash: string, path: string): Promise<GitDiff> {
    return getMako().gitCommitFileDiff(hash, path)
  },

  commitDiffAll(hash: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return getMako().gitCommitDiffAll(hash)
  },

  stage(paths: string[]): Promise<void> {
    return getMako().gitStage(paths)
  },

  unstage(paths: string[]): Promise<void> {
    return getMako().gitUnstage(paths)
  },

  stageAll(): Promise<void> {
    return getMako().gitStageAll()
  },

  unstageAll(): Promise<void> {
    return getMako().gitUnstageAll()
  },

  log(limit?: number): Promise<GitCommitEntry[]> {
    return getMako().gitLog(limit)
  },

  commitFiles(hash: string): Promise<GitCommitFile[]> {
    return getMako().gitCommitFiles(hash)
  },

  commit(message: string, options?: { amend?: boolean }): Promise<void> {
    return getMako().gitCommit(message, options)
  },

  push(): Promise<void> {
    return getMako().gitPush()
  },

  generateMessage(options?: {
    prompt?: string
    model?: string
  }): Promise<string> {
    return getMako().generateCommitMessage(options)
  },

  defaultPrompt(): Promise<string> {
    return getMako().defaultCommitPrompt()
  },
}
