import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { GitHubStatus, PullRequest } from "@/lib/types"

/**
 * The pull request for the branch you are on.
 *
 * Refreshed on demand rather than polled. A PR's checks do move on their own,
 * but polling GitHub every few seconds for a repo nobody is looking at is the
 * kind of background cost that shows up as a fan spinning — so it refreshes
 * when the panel appears, when the branch changes, and when you ask.
 */

export interface GitHubState {
  status?: GitHubStatus
  pull?: PullRequest | null
  loading: boolean
  /** The branch the current `pull` was fetched for, so a switch invalidates it. */
  branch?: string
  root?: string
  /** The signed-in user's avatar as a data URL, for the identity badge. */
  userAvatar?: string
}

export const githubStore = createStore<GitHubState>({ loading: false })
export const useGitHub = createHook(githubStore)

let generation = 0

export const github = {
  async ensureStatus(root?: string) {
    if (!hasBridge()) return
    const current = githubStore.get()
    if (current.status && (root === undefined || current.root === root)) return
    const mine = ++generation
    if (root !== undefined) {
      githubStore.set({
        root,
        status: undefined,
        pull: null,
        branch: undefined,
        loading: true,
      })
    }
    const status = await getMako().githubStatus().catch(() => undefined)
    if (mine !== generation) return
    githubStore.set({
      status,
      root: root ?? current.root,
      loading: false,
      userAvatar: status?.authenticated
        ? githubStore.get().userAvatar
        : undefined,
    })
    void github.ensureUserAvatar()
  },

  /** Best effort and quiet: no avatar means a monogram, never a toast. */
  async ensureUserAvatar() {
    if (!hasBridge()) return
    const { status, userAvatar } = githubStore.get()
    if (userAvatar || !status?.authenticated) return
    const avatar = await getMako().userAvatar().catch(() => undefined)
    if (avatar) githubStore.set({ userAvatar: avatar })
  },

  async refresh(root: string, branch?: string) {
    if (!hasBridge()) return
    await github.ensureStatus(root)
    const status = githubStore.get()
    if (status.root !== root) return
    if (!status.status?.authenticated || !status.status.repo) {
      githubStore.set({ pull: null, loading: false, branch, root })
      return
    }
    const mine = ++generation
    githubStore.set({ loading: true })
    const pull = await getMako().pullRequest().catch(() => null)
    if (mine !== generation || githubStore.get().root !== root) return
    githubStore.set({ pull, loading: false, branch, root })
  },

  listBranches(): Promise<string[]> {
    return getMako().pullBranches()
  },

  async create(options: { title: string; body: string; base?: string; draft?: boolean }) {
    const root = githubStore.get().root
    const pull = await getMako().createPull(options)
    if (githubStore.get().root === root) githubStore.set({ pull })
    return pull
  },

  async merge(strategy: "merge" | "squash" | "rebase") {
    const root = githubStore.get().root
    const pull = await getMako().mergePull(strategy)
    if (githubStore.get().root === root) githubStore.set({ pull })
    return pull
  },

  async rerun() {
    const { root, branch } = githubStore.get()
    if (!root) return
    await getMako().rerunChecks()
    await github.refresh(root, branch)
  },
}
