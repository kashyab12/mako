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
  /** The signed-in user's avatar as a data URL, for the identity badge. */
  userAvatar?: string
}

export const githubStore = createStore<GitHubState>({ loading: false })
export const useGitHub = createHook(githubStore)

let generation = 0

export const github = {
  /** Load status once; it does not change while the app is open. */
  async ensureStatus() {
    if (!hasBridge() || githubStore.get().status) return
    const status = await getMako().githubStatus().catch(() => undefined)
    if (status) githubStore.set({ status })
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

  async refresh(branch?: string) {
    if (!hasBridge()) return
    await github.ensureStatus()
    const status = githubStore.get().status
    if (!status?.authenticated || !status.repo) {
      githubStore.set({ pull: null, loading: false, branch })
      return
    }
    const mine = ++generation
    githubStore.set({ loading: true })
    const pull = await getMako().pullRequest().catch(() => null)
    if (mine !== generation) return
    githubStore.set({ pull, loading: false, branch })
  },

  async create(options: { title: string; body: string; base?: string; draft?: boolean }) {
    const pull = await getMako().createPull(options)
    githubStore.set({ pull })
    return pull
  },

  async merge(strategy: "merge" | "squash" | "rebase") {
    const pull = await getMako().mergePull(strategy)
    githubStore.set({ pull })
    return pull
  },

  async rerun() {
    await getMako().rerunChecks()
    await github.refresh(githubStore.get().branch)
  },
}
