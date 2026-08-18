import { app } from "electron"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { PullRequest, GitHubStatus, CheckSummary, ReviewSummary } from "./shared.js"

const run = promisify(execFile)

/**
 * GitHub, through the `gh` CLI.
 *
 * Not through the REST API with an OAuth flow of our own, and that is a
 * decision rather than a shortcut. Anyone running an agent on a repo already
 * has `gh` authenticated, usually with an SSH protocol preference and an org
 * scope we would otherwise have to ask for again. Building a second login for
 * the same account is asking the user to solve a problem they already solved.
 *
 * The cost is a dependency we do not control, so every call degrades: no `gh`,
 * no auth, or no remote each report themselves plainly rather than failing.
 */

/** Ceilings so a hung `gh` cannot hold a panel open forever. */
const TIMEOUT = 15_000
const MAX_BUFFER = 8 * 1024 * 1024

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { cwd, timeout: TIMEOUT, maxBuffer: MAX_BUFFER })
  return stdout
}

async function ghJson<T>(cwd: string, args: string[]): Promise<T | null> {
  try {
    return JSON.parse(await gh(cwd, args)) as T
  } catch {
    return null
  }
}

/**
 * Whether GitHub is usable here, and if not, exactly why.
 *
 * Three different "no"s that want three different answers from the UI —
 * install a tool, log in, or add a remote — so they are three different
 * fields rather than one boolean.
 */
export async function githubStatus(cwd: string): Promise<GitHubStatus> {
  try {
    await run("gh", ["--version"], { cwd, timeout: TIMEOUT })
  } catch {
    return { installed: false, authenticated: false }
  }

  let login: string | undefined
  try {
    const who = await ghJson<{ login?: string }>(cwd, ["api", "user", "--jq", "{login: .login}"])
    login = who?.login
  } catch {
    login = undefined
  }
  if (!login) return { installed: true, authenticated: false }

  const repo = await ghJson<{ nameWithOwner?: string; defaultBranchRef?: { name?: string } }>(cwd, [
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef",
  ])

  return {
    installed: true,
    authenticated: true,
    login,
    repo: repo?.nameWithOwner,
    defaultBranch: repo?.defaultBranchRef?.name,
  }
}

interface RawCheck {
  name?: string
  context?: string
  state?: string
  conclusion?: string
  status?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawPull {
  number: number
  title: string
  body?: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  baseRefName: string
  additions?: number
  deletions?: number
  changedFiles?: number
  mergeable?: string
  reviewDecision?: string
  createdAt?: string
  updatedAt?: string
  author?: { login?: string }
  statusCheckRollup?: RawCheck[]
  latestReviews?: Array<{ state?: string; author?: { login?: string } }>
}

const PULL_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "isDraft",
  "url",
  "headRefName",
  "baseRefName",
  "additions",
  "deletions",
  "changedFiles",
  "mergeable",
  "reviewDecision",
  "createdAt",
  "updatedAt",
  "author",
  "statusCheckRollup",
  "latestReviews",
].join(",")

/**
 * Normalize a check.
 *
 * GitHub has two check systems with different shapes — the Checks API and the
 * older commit statuses — and `gh` passes both through as they come. Anything
 * downstream of here sees one shape, because "is CI green" should not require
 * the reader to know which system a repo happens to use.
 */
function toCheck(raw: RawCheck): CheckSummary {
  const name = raw.name ?? raw.context ?? "check"
  const url = raw.detailsUrl ?? raw.targetUrl
  const verdict = (raw.conclusion ?? raw.state ?? "").toUpperCase()
  const running = (raw.status ?? "").toUpperCase()

  if (running === "IN_PROGRESS" || running === "QUEUED" || running === "PENDING" || verdict === "PENDING") {
    return { name, state: "running", url }
  }
  if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") {
    return { name, state: "passed", url }
  }
  if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT" || verdict === "CANCELLED") {
    return { name, state: "failed", url }
  }
  return { name, state: "unknown", url }
}

function toReviews(raw: RawPull["latestReviews"]): ReviewSummary[] {
  return (raw ?? []).map((review) => ({
    login: review.author?.login ?? "someone",
    state:
      review.state === "APPROVED"
        ? "approved"
        : review.state === "CHANGES_REQUESTED"
          ? "changes"
          : "commented",
  }))
}

function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
    draft: Boolean(raw.isDraft),
    url: raw.url,
    head: raw.headRefName,
    base: raw.baseRefName,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    files: raw.changedFiles ?? 0,
    mergeable: raw.mergeable === "MERGEABLE" ? "clean" : raw.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    reviewDecision:
      raw.reviewDecision === "APPROVED"
        ? "approved"
        : raw.reviewDecision === "CHANGES_REQUESTED"
          ? "changes"
          : raw.reviewDecision === "REVIEW_REQUIRED"
            ? "required"
            : "none",
    author: raw.author?.login,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    checks: (raw.statusCheckRollup ?? []).map(toCheck),
    reviews: toReviews(raw.latestReviews),
  }
}

/** The pull request for the branch you are on, if there is one. */
export async function pullForBranch(cwd: string): Promise<PullRequest | null> {
  const raw = await ghJson<RawPull>(cwd, ["pr", "view", "--json", PULL_FIELDS])
  return raw && typeof raw.number === "number" ? toPull(raw) : null
}

export async function listPulls(cwd: string, limit = 20): Promise<PullRequest[]> {
  const raw = await ghJson<RawPull[]>(cwd, [
    "pr",
    "list",
    "--limit",
    String(limit),
    "--json",
    PULL_FIELDS,
  ])
  return Array.isArray(raw) ? raw.map(toPull) : []
}

export interface CreatePullOptions {
  title: string
  body: string
  base?: string
  draft?: boolean
}

/**
 * Open a pull request.
 *
 * The branch is pushed first when it has no upstream, because `gh pr create`
 * against an unpushed branch fails in a way that reads like a GitHub problem
 * rather than a local one. Everything else is left to `gh`, including the
 * default base, which respects whatever the repository has configured.
 */
export async function createPull(cwd: string, options: CreatePullOptions): Promise<PullRequest | null> {
  await run("git", ["push", "--set-upstream", "origin", "HEAD"], { cwd, timeout: 120_000 }).catch(
    async (error: unknown) => {
      // Already published is not a failure; anything else is.
      const message = error instanceof Error ? error.message : String(error)
      if (!/everything up-to-date|up to date/i.test(message)) throw error
    }
  )

  const args = ["pr", "create", "--title", options.title, "--body", options.body]
  if (options.base) args.push("--base", options.base)
  if (options.draft) args.push("--draft")
  await gh(cwd, args)
  return pullForBranch(cwd)
}

/**
 * The project's avatar, as a data URL.
 *
 * Fetched here and cached to disk rather than pointed at from an `<img>` in
 * the renderer. Two reasons: it works offline after the first look, and the
 * window makes no network request of its own — everything Mako sends to
 * GitHub goes through one file, which is the only way that claim stays
 * checkable.
 *
 * Failure is silent and returns nothing. A missing logo is a folder icon; it
 * is not worth a toast, a retry, or a line in a crash report.
 */
export async function repoAvatar(cwd: string, repo: string): Promise<string | undefined> {
  const owner = repo.split("/")[0]
  if (!owner) return undefined

  const dir = join(app.getPath("userData"), "avatars")
  const file = join(dir, `${owner.replace(/[^\w.-]/g, "-")}.png`)
  try {
    return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
  } catch {
    // Not cached yet.
  }

  try {
    const url = (await gh(cwd, ["api", `repos/${repo}`, "--jq", ".owner.avatar_url"])).trim()
    if (!url.startsWith("https://")) return undefined
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}s=128`)
    if (!response.ok) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    // A logo is a few kilobytes; anything much larger is not one.
    if (bytes.length > 512_000) return undefined
    await mkdir(dir, { recursive: true })
    await writeFile(file, bytes)
    return `data:image/png;base64,${bytes.toString("base64")}`
  } catch {
    return undefined
  }
}

/** Ask GitHub to re-run whatever failed, rather than making the user leave. */
export async function rerunChecks(cwd: string): Promise<void> {
  await gh(cwd, ["run", "rerun", "--failed"]).catch(async () => {
    // No failed run to retry is a normal outcome, not an error worth raising.
  })
}
