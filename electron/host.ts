import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent"
import {
  THINKING_LEVELS,
  type Block,
  type Capabilities,
  type ChatRole,
  type ContextUsage,
  type FileContents,
  type GitDiff,
  type GitFile,
  type GitFileStatus,
  type GitStatus,
  type HostEvent,
  type ModelInfo,
  type PiMessage,
  type SessionMeta,
  type SessionState,
  type SessionSummary,
  type StagedFile,
  type ThinkingLevel,
  type GitCommitEntry,
  type ToolSummary,
  type TreeNode,
  type WorkspaceFile,
} from "./shared.js"

const execFileAsync = promisify(execFile)

/** Run a reader that may throw, falling back rather than failing the caller. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Untracked files above this size are not line-counted for the status list. */
const UNTRACKED_STAT_LIMIT = 2_000_000

/**
 * The most of a file the viewer will render.
 *
 * Two megabytes is far past any source file and far short of what freezes a
 * renderer. Above it the head is shown and the viewer says the rest was cut.
 */
const FILE_VIEW_LIMIT = 2_000_000

/** The `@` picker re-queries per keystroke; the file set does not move that fast. */
const FILE_CACHE_MS = 5_000

/** Ceilings for the non-git walk, so a stray home directory cannot hang the picker. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_FILES = 20_000
const WALK_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".venv",
  "venv", "__pycache__", ".cache", "vendor", "Pods", ".turbo", "coverage",
])

/* ------------------------------------------------------------------ */
/* serialization                                                       */
/* ------------------------------------------------------------------ */

function blocksFrom(content: unknown): Block[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Block[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") {
      if (part != null) blocks.push({ type: "text", text: String(part) })
      continue
    }
    const rec = part as Record<string, unknown>
    switch (rec.type) {
      case "thinking":
        blocks.push({ type: "thinking", thinking: String(rec.thinking ?? "") })
        break
      case "toolCall":
        blocks.push({
          type: "toolCall",
          id: String(rec.id ?? ""),
          name: String(rec.name ?? "tool"),
          arguments: rec.arguments,
        })
        break
      case "image":
        blocks.push({ type: "image", mimeType: String(rec.mimeType ?? "") })
        break
      default:
        blocks.push({ type: "text", text: String(rec.text ?? "") })
    }
  }
  return blocks
}

function serializeMessage(raw: Record<string, unknown>, id: string): PiMessage {
  const role = String(raw.role ?? "system")
  if (role === "toolResult" || role === "tool") {
    return {
      id,
      role: "tool",
      blocks: blocksFrom(raw.content),
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
      toolName: String(raw.toolName ?? "tool"),
      toolCallId: String(raw.toolCallId ?? ""),
      isError: Boolean(raw.isError),
    }
  }
  return {
    id,
    role: role === "assistant" || role === "user" ? role : "system",
    blocks: blocksFrom(raw.content),
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    error: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
  }
}

function entryPreview(entry: SessionEntry): { preview: string; role?: ChatRole } {
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>
    const raw = String(message.role ?? "system")
    const role: ChatRole =
      raw === "assistant"
        ? "assistant"
        : raw === "user"
          ? "user"
          : raw === "toolResult"
            ? "tool"
            : "system"
    const content = message.content
    let preview = ""
    if (typeof content === "string") preview = content
    else if (Array.isArray(content)) {
      preview = content
        .map((part) => {
          if (typeof part === "string") return part
          if (!part || typeof part !== "object") return ""
          const rec = part as Record<string, unknown>
          if (typeof rec.text === "string") return rec.text
          if (typeof rec.thinking === "string") return rec.thinking
          if (rec.type === "toolCall") return `→ ${String(rec.name ?? "tool")}`
          return ""
        })
        .join(" ")
    }
    return { preview: preview.replace(/\s+/g, " ").trim().slice(0, 200), role }
  }
  if (entry.type === "compaction") return { preview: `Compacted · ${entry.summary.slice(0, 140)}` }
  if (entry.type === "branch_summary") return { preview: `Branch · ${entry.summary.slice(0, 140)}` }
  if (entry.type === "model_change") return { preview: `${entry.provider}/${entry.modelId}` }
  if (entry.type === "thinking_level_change") return { preview: `Thinking · ${entry.thinkingLevel}` }
  if (entry.type === "session_info") return { preview: entry.name ? entry.name : "Session info" }
  return { preview: entry.type }
}

/**
 * Flatten Pi's tree and mark the root→leaf path so the UI can dim abandoned
 * branches. The output is a flat list: see the note on `TreeNode` for why
 * nesting is not an option here.
 */
function serializeTree(nodes: SessionTreeNode[], leafId: string | null): TreeNode[] {
  const flat: TreeNode[] = []
  const byId = new Map<string, TreeNode>()

  const visit = (node: SessionTreeNode) => {
    const { preview, role } = entryPreview(node.entry)
    const serialized: TreeNode = {
      id: node.entry.id,
      parentId: node.entry.parentId,
      type: node.entry.type,
      label: node.label,
      timestamp: node.entry.timestamp,
      preview,
      role,
      onPath: false,
      childIds: node.children.map((child) => child.entry.id),
    }
    flat.push(serialized)
    byId.set(serialized.id, serialized)
    for (const child of node.children) visit(child)
  }
  for (const root of nodes) visit(root)

  // Walk up from the leaf rather than down from the roots: the path is one
  // chain, so this is linear instead of a full traversal.
  let cursor = leafId
  const guard = new Set<string>()
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor)
    const node = byId.get(cursor)
    if (!node) break
    node.onPath = true
    cursor = node.parentId
  }

  return flat
}

function thinkingLevelsFor(model: {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
}): ThinkingLevel[] {
  if (!model.reasoning) return ["off"]
  const map = model.thinkingLevelMap
  if (!map) return [...THINKING_LEVELS]
  return THINKING_LEVELS.filter((level) => level === "off" || map[level] !== null)
}

function toModelInfo(model: Record<string, unknown>): ModelInfo {
  const cost = (model.cost ?? {}) as Record<string, number>
  return {
    provider: String(model.provider),
    id: String(model.id),
    name: String(model.name ?? model.id),
    reasoning: Boolean(model.reasoning),
    thinkingLevels: thinkingLevelsFor(model as never),
    contextWindow: Number(model.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? 0),
    input: Array.isArray(model.input) ? (model.input as ("text" | "image")[]) : ["text"],
    cost: {
      input: Number(cost.input ?? 0),
      output: Number(cost.output ?? 0),
      cacheRead: Number(cost.cacheRead ?? 0),
      cacheWrite: Number(cost.cacheWrite ?? 0),
    },
  }
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

async function git(root: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path)
    if (buf.includes(0)) return null
    return buf.toString("utf8")
  } catch {
    return null
  }
}

function statusFor(xy: string): GitFileStatus {
  if (xy === "??") return "untracked"
  if (xy.includes("R")) return "renamed"
  if (xy.includes("D")) return "deleted"
  if (xy.includes("A")) return "added"
  return "modified"
}

/* ------------------------------------------------------------------ */
/* host                                                                */
/* ------------------------------------------------------------------ */

/**
 * One agent, hosted.
 *
 * Exactly one conversation runs here: one runtime, one working directory, one
 * git root, one coalescing budget. Several of these run side by side — see
 * `HostPool` — which is what lets a forked conversation keep streaming while
 * you read the original.
 *
 * Everything specific to the agent backend lives inside this class. Nothing
 * above it names Pi, so swapping the runtime out is a change to one file.
 */
export class AgentHost {
  readonly id: string
  private runtime: AgentSessionRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private cwd = homedir()
  private emit: (event: HostEvent) => void

  /** Coalescing state — the hot path batches into one emission per frame. */
  private pending = { meta: false, messages: false, tree: false, stream: false }
  private flushTimer: NodeJS.Timeout | null = null
  private gitTimer: NodeJS.Timeout | null = null
  private gitRoot: string | null = null
  private lastStreamKey = ""
  private fileCache: { at: number; files: WorkspaceFile[] } | null = null
  /**
   * Whether this tab is the one on screen.
   *
   * A background tab has no transcript rendering it, so sending sixty stream
   * frames a second would be pure waste on a wire that the *visible* tab is
   * also using. Backgrounded, it emits only the scalars the tab strip needs to
   * show that it is still working, and hands over everything else in one go
   * when it is brought forward.
   */
  private foreground = true

  constructor(id: string, emit: (event: HostEvent) => void) {
    this.id = id
    this.emit = (event) => emit({ ...event, tabId: id })
  }

  get session(): AgentSession {
    if (!this.runtime) throw new Error("The agent is not ready yet")
    return this.runtime.session
  }

  get ready(): boolean {
    return this.runtime !== null
  }

  /** The folder this tab's agent is working in. */
  get workspace(): string {
    return this.cwd
  }

  /** The session file backing this tab, if it has been written yet. */
  get sessionFile(): string | undefined {
    return this.runtime ? this.session.sessionFile : undefined
  }

  setForeground(value: boolean) {
    if (this.foreground === value) return
    this.foreground = value
    // Coming forward, replay everything that was skipped while hidden.
    if (value && this.runtime) {
      this.pushState()
      void this.pushGit()
      void this.pushCapabilities()
    }
  }

  /* -------------------------------------------------- lifecycle */

  async start(cwd = this.cwd) {
    this.cwd = cwd
    await this.teardown()
    const agentDir = getAgentDir()
    this.runtime = await createAgentSessionRuntime(
      async ({ cwd: nextCwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({ cwd: nextCwd, agentDir })
        return {
          ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
          services,
          diagnostics: services.diagnostics,
        }
      },
      { cwd, agentDir, sessionManager: SessionManager.create(cwd) }
    )
    this.gitRoot = await findGitRoot(cwd)
    this.fileCache = null
    this.bind()
  }

  private bind() {
    this.unsubscribe?.()
    this.unsubscribe = this.session.subscribe((event) => {
      switch (event.type) {
        // Hot path: one message changed. Nothing else moves.
        case "message_update":
        case "message_start":
          this.pending.stream = true
          this.schedule()
          break
        case "message_end":
        case "entry_appended":
          this.pending.messages = true
          this.pending.tree = true
          this.pending.stream = true
          this.pending.meta = true
          this.schedule()
          break
        case "tool_execution_end":
          this.pending.stream = true
          this.pending.messages = true
          this.schedule()
          if (["edit", "write", "bash", "multiedit"].includes(event.toolName)) this.scheduleGit()
          break
        case "agent_start":
        case "agent_end":
        case "agent_settled":
        case "turn_end":
        case "queue_update":
        case "session_info_changed":
        case "thinking_level_changed":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
          this.pending.meta = true
          this.pending.messages = true
          this.schedule()
          if (event.type === "agent_end" || event.type === "compaction_end") this.scheduleGit()
          break
        default:
          this.pending.meta = true
          this.schedule()
      }
    })
  }

  /** ~60fps ceiling on renderer traffic; every burst collapses to one flush. */
  private schedule() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null
        this.flush()
      },
      this.foreground ? 16 : 400
    )
  }

  private flush() {
    if (!this.runtime) return
    const { meta, messages, tree, stream } = this.pending
    this.pending = { meta: false, messages: false, tree: false, stream: false }
    try {
      // Hidden: only the scalars, which is all the tab strip reads. The heavy
      // payloads are rebuilt on the way forward, so skipping them here cannot
      // leave the transcript stale.
      if (!this.foreground) {
        if (meta || messages || tree || stream) this.emit({ type: "meta", meta: this.meta() })
        return
      }
      if (stream) {
        const message = this.streamingMessage()
        // Skip the emission entirely when nothing about the draft changed.
        const key = message ? `${message.blocks.length}:${JSON.stringify(message.blocks).length}` : ""
        if (key !== this.lastStreamKey) {
          this.lastStreamKey = key
          this.emit({ type: "stream", message })
        }
      }
      if (messages) this.emit({ type: "messages", messages: this.messages() })
      if (tree) {
        const leafId = this.session.sessionManager.getLeafId()
        this.emit({ type: "tree", tree: serializeTree(this.session.sessionManager.getTree(), leafId), leafId })
      }
      if (meta) this.emit({ type: "meta", meta: this.meta() })
    } catch (error) {
      this.notice("error", error)
    }
  }

  private scheduleGit() {
    if (this.gitTimer) return
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null
      void this.pushGit()
    }, 350)
  }

  private notice(level: "info" | "success" | "error", error: unknown) {
    this.emit({
      type: "notice",
      level,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /* -------------------------------------------------- reads */

  private streamingMessage(): PiMessage | null {
    const raw = this.session.state.streamingMessage as Record<string, unknown> | undefined
    if (!raw) return null
    return { ...serializeMessage(raw, "draft"), streaming: true }
  }

  messages(): PiMessage[] {
    return this.session.messages.map((message, index) =>
      serializeMessage(message as unknown as Record<string, unknown>, `m${index}`)
    )
  }

  meta(): SessionMeta {
    const session = this.session
    const manager = session.sessionManager
    const model = session.model as unknown as Record<string, unknown> | undefined
    const stats = session.getSessionStats()
    let context: ContextUsage | undefined
    try {
      context = session.getContextUsage()
    } catch {
      context = undefined
    }
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: this.cwd,
      leafId: manager.getLeafId(),
      model: model ? toModelInfo(model) : undefined,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      thinkingLevels: model ? thinkingLevelsFor(model as never) : ["off"],
      isStreaming: session.isStreaming,
      isIdle: session.isIdle,
      isCompacting: session.isCompacting,
      isRetrying: session.isRetrying,
      isBashRunning: session.isBashRunning,
      autoCompaction: session.autoCompactionEnabled,
      queued: {
        steering: [...session.getSteeringMessages()],
        followUp: [...session.getFollowUpMessages()],
      },
      cost: stats.cost,
      tokens: stats.tokens,
      context,
      messageCount: session.messages.length,
    }
  }

  state(): SessionState {
    const leafId = this.session.sessionManager.getLeafId()
    return {
      meta: this.meta(),
      messages: this.messages(),
      tree: serializeTree(this.session.sessionManager.getTree(), leafId),
    }
  }

  pushState() {
    if (!this.foreground) return
    this.lastStreamKey = ""
    this.emit({ type: "session", session: this.state() })
    this.emit({ type: "stream", message: this.streamingMessage() })
  }

  /* -------------------------------------------------- sessions */

  /**
   * Sessions for the rail. `scope: "all"` reaches across every project Pi has
   * ever run in, which is what makes the rail a way to move between projects
   * rather than only within the current one.
   */
  async listSessions(
    cwd = this.cwd,
    scope: "workspace" | "all" = "workspace"
  ): Promise<SessionSummary[]> {
    const sessions =
      scope === "all" ? await SessionManager.listAll() : await SessionManager.list(cwd)
    return sessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map((session) => ({
        path: session.path,
        id: session.id,
        cwd: session.cwd,
        name: session.name,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
      }))
  }

  async newSession() {
    if (!this.runtime) throw new Error("The agent is not ready yet")
    await this.runtime.newSession()
    this.bind()
    this.pushState()
    void this.pushCapabilities()
  }

  async openSession(path: string) {
    if (!this.runtime) throw new Error("The agent is not ready yet")
    await this.runtime.switchSession(path)
    this.cwd = this.session.sessionManager.getCwd() || this.cwd
    this.gitRoot = await findGitRoot(this.cwd)
    this.bind()
    this.pushState()
    void this.pushGit()
    void this.pushCapabilities()
  }

  async setCwd(cwd: string) {
    await this.start(cwd)
    this.pushState()
    void this.pushGit()
    void this.pushCapabilities()
  }

  /* -------------------------------------------------- agent control */

  async prompt(
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ) {
    const session = this.session
    const attachments = images?.length
      ? images.map((image) => ({ type: "image" as const, ...image }))
      : undefined
    if (session.isStreaming) {
      await session.prompt(text, {
        streamingBehavior: mode ?? "steer",
        ...(attachments ? { images: attachments } : {}),
      })
      return
    }
    await session.prompt(text, attachments ? { images: attachments } : undefined)
  }

  async abort() {
    await this.session.abort()
    this.pending.meta = true
    this.pending.messages = true
    this.schedule()
  }

  clearQueue() {
    this.session.clearQueue()
    this.pending.meta = true
    this.schedule()
  }

  /**
   * Branch the conversation at a past turn into a *new* session.
   *
   * Distinct from `navigateTree`, which rewinds this session onto another
   * branch of the same file — that abandons where you were. Forking keeps the
   * original intact and gives the new line of enquiry its own session, which
   * is what you want when the point is to try two things and compare them.
   *
   * `position: "before"` puts the fork just ahead of the chosen prompt, so the
   * new session ends with that prompt ready to be re-answered differently
   * rather than replaying the answer you already have.
   */
  async fork(entryId: string) {
    if (!this.runtime) throw new Error("The agent is not ready yet")
    const result = await this.runtime.fork(entryId, { position: "before" })
    if (result.cancelled) return { cancelled: true as const }
    this.cwd = this.session.sessionManager.getCwd() || this.cwd
    this.bind()
    this.pushState()
    void this.pushGit()
    void this.pushCapabilities()
    return { cancelled: false as const, text: result.selectedText }
  }

  async navigateTree(targetId: string) {
    await this.session.navigateTree(targetId, { summarize: false })
    this.pushState()
  }

  setName(name: string) {
    this.session.setSessionName(name)
    this.pending.meta = true
    this.schedule()
  }

  async setModel(provider: string, id: string) {
    const model = this.session.modelRuntime.getModel(provider, id)
    if (!model) throw new Error(`Unknown model ${provider}/${id}`)
    await this.session.setModel(model)
    this.pending.meta = true
    this.schedule()
    void this.pushCapabilities()
  }

  setThinking(level: ThinkingLevel) {
    this.session.setThinkingLevel(level)
    this.pending.meta = true
    this.schedule()
  }

  async compact(instructions?: string) {
    await this.session.compact(instructions)
    this.pushState()
  }

  setAutoCompaction(enabled: boolean) {
    this.session.setAutoCompactionEnabled(enabled)
    this.pending.meta = true
    this.schedule()
  }

  async listModels(): Promise<ModelInfo[]> {
    const available = await this.session.modelRuntime.getAvailable()
    return available
      .map((model) => toModelInfo(model as unknown as Record<string, unknown>))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
  }

  /* -------------------------------------------------- capabilities */

  /**
   * Each capability is read behind its own guard: an extension that breaks
   * command registration should not also cost the UI its tool list.
   */
  capabilities(): Capabilities {
    const session = this.session
    return {
      tools: attempt<ToolSummary[]>(() => {
        const active = new Set(session.getActiveToolNames())
        return session.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          active: active.has(tool.name),
          source: (tool as { sourceInfo?: { source?: string } }).sourceInfo?.source,
        }))
      }, []),
      commands: attempt<Capabilities["commands"]>(
        () =>
          session.extensionRunner.getRegisteredCommands().map((command) => ({
            name: command.invocationName ?? command.name,
            description: command.description,
            source: command.sourceInfo?.source,
          })),
        []
      ),
      skills: attempt<Capabilities["skills"]>(
        () =>
          session.resourceLoader
            .getSkills()
            .skills.filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              source: skill.sourceInfo?.source,
            })),
        []
      ),
    }
  }

  async pushCapabilities() {
    if (!this.foreground) return
    try {
      this.emit({ type: "capabilities", capabilities: this.capabilities() })
    } catch (error) {
      this.notice("error", error)
    }
  }

  setActiveTools(names: string[]) {
    this.session.setActiveToolsByName(names)
    void this.pushCapabilities()
  }

  async runCommand(name: string, args = "") {
    const runner = this.session.extensionRunner
    const command = runner.getCommand(name)
    if (!command) throw new Error(`Unknown command /${name}`)
    await command.handler(args, runner.createCommandContext())
    this.pushState()
  }

  /* -------------------------------------------------- git */

  async gitStatus(): Promise<GitStatus> {
    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    this.gitRoot = root
    if (!root) return { cwd: this.cwd, ahead: 0, behind: 0, files: [] }

    const [branchOut, statusOut, numstatOut, cachedOut] = await Promise.all([
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]),
      git(root, ["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
      git(root, ["diff", "--numstat", "-z", "--cached"]).catch(() => ""),
    ])

    // numstat -z emits "adds\tdels\tpath\0", with renames as three NUL fields.
    // Staged-only changes do not appear in `diff HEAD` once committed-to-index,
    // so both sides are parsed and merged; otherwise a staged file shows 0/0.
    const stats = parseNumstat(numstatOut)
    for (const [path, stat] of parseNumstat(cachedOut)) {
      if (!stats.has(path)) stats.set(path, stat)
    }

    const parts = statusOut.split("\0").filter(Boolean)
    const header = parts.shift() ?? ""
    const files: GitFile[] = []
    for (let i = 0; i < parts.length; i += 1) {
      const line = parts[i]
      if (!line || line.length < 4) continue
      const xy = line.slice(0, 2)
      let path = line.slice(3)
      let oldName: string | undefined
      if (xy.includes("R") || xy.includes("C")) {
        oldName = path
        path = parts[i + 1] ?? path
        i += 1
      }
      const status = statusFor(xy)
      const stat = stats.get(path)
      // Untracked files have no HEAD to diff against, so their "insertions"
      // are simply their line count, read once here.
      const counted =
        status === "untracked" ? await countLines(join(root, path)) : null
      const insertions = counted ? counted.lines : (stat?.insertions ?? 0)
      const deletions = stat?.deletions ?? 0
      const binary = counted?.binary ?? false
      files.push({
        path,
        status,
        oldName,
        insertions,
        deletions,
        binary,
        staged: xy[0] !== " " && xy[0] !== "?",
      })
    }

    return {
      cwd: this.cwd,
      root,
      branch: branchOut.trim() || undefined,
      upstream: /\.\.\.(\S+)/.exec(header)?.[1],
      ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
      operation: await inProgressOperation(root),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  /**
   * The workspace file list backing the composer's `@` picker.
   *
   * `git ls-files` is the right source: it already respects .gitignore, so we
   * never walk node_modules. The result is cached for a few seconds because
   * the picker re-queries on every keystroke and the file set does not move
   * that fast.
   */
  async listFiles(): Promise<WorkspaceFile[]> {
    const now = Date.now()
    if (this.fileCache && now - this.fileCache.at < FILE_CACHE_MS) return this.fileCache.files

    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    this.gitRoot = root

    const paths = root
      ? await Promise.all([
          git(root, ["ls-files", "-z"]).catch(() => ""),
          git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).catch(() => ""),
        ]).then(([tracked, untracked]) =>
          [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean)
        )
      : // Not a repo: a bounded walk, skipping the usual heavy directories.
        await walk(this.cwd, this.cwd, 0)

    const changed = new Set((await this.gitStatus().catch(() => null))?.files.map((f) => f.path) ?? [])
    const files = paths
      .sort((a, b) => a.localeCompare(b))
      .map((path) => (changed.has(path) ? { path, changed: true } : { path }))

    this.fileCache = { at: now, files }
    return files
  }

  /**
   * Write an attachment the model cannot take inline into a scratch directory
   * inside the agent dir, and return its path. Pi's read/bash tools can then
   * reach it, which is the difference between "attach anything" and pretending
   * to.
   */
  async stageFile(name: string, base64: string): Promise<StagedFile> {
    const dir = join(getAgentDir(), "attachments")
    await mkdir(dir, { recursive: true })
    // Keep the original name legible but collision-free, and never let a name
    // escape the directory it is written into.
    const safe = name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"
    const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
    const target = join(dir, `${stamp}-${safe}`)
    const bytes = Buffer.from(base64, "base64")
    await writeFile(target, bytes)
    return { path: target, name: safe, size: bytes.byteLength }
  }

  /** Absolute path for a workspace-relative one, for reveal/open. */
  /**
   * Read a workspace file for the viewer.
   *
   * Two guards, both about not hanging the window on something it cannot show
   * anyway: a byte ceiling, because a 40MB log renders as a frozen tab, and a
   * NUL check, because a binary opened as text is a screenful of noise that
   * takes longer to draw than to read. Both are reported rather than silently
   * applied — a truncated file that does not say so is a lie about the code.
   */
  async readWorkspaceFile(path: string): Promise<FileContents> {
    const absolute = await this.resolvePath(path)
    const info = await stat(absolute)
    if (info.isDirectory()) throw new Error(`${path} is a directory`)

    const handle = await open(absolute, "r")
    try {
      const length = Math.min(info.size, FILE_VIEW_LIMIT)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      // A NUL byte in the first few KB is the same heuristic git uses, and it
      // is right far more often than sniffing extensions.
      if (buffer.subarray(0, 8000).includes(0)) {
        return { path, contents: "", size: info.size, binary: true, truncated: false }
      }
      return {
        path,
        contents: buffer.toString("utf8"),
        size: info.size,
        binary: false,
        truncated: info.size > FILE_VIEW_LIMIT,
      }
    } finally {
      await handle.close()
    }
  }

  async resolvePath(path: string): Promise<string> {
    if (isAbsolute(path)) return path
    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    return join(root ?? this.cwd, path)
  }

  /** Contents for one file — fetched only when the user opens it. */
  async gitDiff(path: string): Promise<GitDiff> {
    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    if (!root) return { path, binary: false, oldFile: null, newFile: null }
    const abs = join(root, path)
    const [head, work] = await Promise.all([
      git(root, ["show", `HEAD:${path}`]).catch(() => null),
      readText(abs),
    ])
    return {
      path,
      binary: head === null && work === null && existsSync(abs),
      oldFile: head == null ? null : { name: path, contents: head },
      newFile: work == null ? null : { name: path, contents: work },
    }
  }

  /* -------------------------------------------------- git operations */

  /**
   * Staging. Paths are workspace-relative and passed after `--` so a file
   * named like a flag can never be read as one.
   */
  async gitStage(paths: string[]) {
    const root = await this.requireRoot()
    await git(root, ["add", "--", ...paths])
    await this.pushGit()
  }

  async gitUnstage(paths: string[]) {
    const root = await this.requireRoot()
    // `reset` fails on a repo with no commits yet; `rm --cached` is the
    // equivalent that works before the first commit exists.
    try {
      await git(root, ["reset", "-q", "HEAD", "--", ...paths])
    } catch {
      await git(root, ["rm", "-q", "--cached", "--", ...paths])
    }
    await this.pushGit()
  }

  async gitStageAll() {
    const root = await this.requireRoot()
    await git(root, ["add", "-A"])
    await this.pushGit()
  }

  async gitUnstageAll() {
    const root = await this.requireRoot()
    try {
      await git(root, ["reset", "-q"])
    } catch {
      // No HEAD yet: nothing was ever committed, so unstage everything.
      await git(root, ["rm", "-rq", "--cached", "."]).catch(() => {})
    }
    await this.pushGit()
  }

  /**
   * The patch that a commit would record, for review and for the model.
   *
   * A repository with no commits has no HEAD, so `diff HEAD` fails outright —
   * which is the state every freshly-initialized repo is in, and exactly when
   * someone most wants a first commit message drafted. There the index is the
   * only reference, and an empty index still has the untracked files to
   * describe.
   */
  async gitPatch(staged: boolean): Promise<string> {
    const root = await this.requireRoot()
    const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"])
      .then(() => true)
      .catch(() => false)

    if (hasHead) {
      const args = staged ? ["diff", "--cached"] : ["diff", "HEAD"]
      const patch = await git(root, [...args, "--no-color"]).catch(() => "")
      if (patch.trim()) return patch
    } else {
      const patch = await git(root, ["diff", "--cached", "--no-color"]).catch(() => "")
      if (patch.trim()) return patch
    }

    // Nothing diffable: fall back to the list of files that would be added, so
    // an initial commit can still be described.
    const status = await this.gitStatus()
    if (status.files.length === 0) return ""
    const lines = status.files
      .slice(0, 400)
      .map((file) => `${file.status}: ${file.path}`)
      .join("\n")
    return `The following files are being added in this commit:\n${lines}`
  }

  /**
   * Draft a commit message with the session's own model.
   *
   * This runs through `completeSimple`, deliberately outside the session: it
   * is a utility call, and folding it into the conversation would spend the
   * user's context on a message they never asked for.
   *
   * The prompt follows the shape Zed uses, because it is a good one — subject
   * in the imperative under 50 characters, a body only when it earns its
   * place — and the diff is truncated per-file so a large change degrades to
   * a partial patch rather than a failed request.
   */
  async generateCommitMessage(promptOverride?: string): Promise<string> {
    const session = this.session
    const model = session.model
    if (!model) throw new Error("No model is selected")

    const staged = await this.hasStagedChanges()
    const patch = await this.gitPatch(staged)
    if (!patch.trim()) throw new Error("There are no changes to describe")

    const result = await session.modelRuntime.completeSimple(model, {
      systemPrompt: promptOverride?.trim() || COMMIT_PROMPT,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: `Here are the changes in this commit:\n\n${truncatePatch(patch, PATCH_BUDGET)}`,
        },
      ],
    })

    const text = Array.isArray(result.content)
      ? result.content
          .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
          .join("")
      : String(result.content ?? "")

    const message = text.trim()
    if (!message) throw new Error("The model returned an empty message")
    return message
  }

  async gitCommit(message: string, options: { amend?: boolean } = {}) {
    const root = await this.requireRoot()
    if (!message.trim()) throw new Error("A commit needs a message")
    // Nothing staged means the user meant "commit what I changed".
    if (!(await this.hasStagedChanges()) && !options.amend) {
      await git(root, ["add", "-A"])
    }
    const args = ["commit", "-m", message]
    if (options.amend) args.push("--amend")
    await git(root, args)
    await this.pushGit()
    this.emit({ type: "notice", level: "success", message: "Committed" })
  }

  /** Push the current branch, setting upstream on first push. */
  async gitPush(): Promise<void> {
    const root = await this.requireRoot()
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
    const hasUpstream = await git(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`])
      .then(() => true)
      .catch(() => false)
    const args = hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", branch]
    const output = await git(root, args)
    await this.pushGit()
    this.emit({
      type: "notice",
      level: "success",
      message: output.trim().split("\n").at(-1) || `Pushed ${branch}`,
    })
  }

  async gitLog(limit = 60): Promise<GitCommitEntry[]> {
    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    if (!root) return []
    // A unit separator keeps subjects containing any punctuation intact.
    const format = ["%H", "%h", "%s", "%an", "%aI"].join("%x1f")
    const out = await git(root, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:${format}`,
      "--shortstat",
    ]).catch(() => "")

    const entries: GitCommitEntry[] = []
    for (const block of out.split("\n")) {
      const line = block.trim()
      if (!line) continue
      if (line.includes("\x1f")) {
        const [hash, shortHash, subject, author, date] = line.split("\x1f")
        entries.push({ hash, shortHash, subject, author, date, files: 0, insertions: 0, deletions: 0 })
        continue
      }
      // A --shortstat line belongs to the commit just pushed.
      const current = entries.at(-1)
      if (!current) continue
      current.files = Number(/(\d+) files? changed/.exec(line)?.[1] ?? 0)
      current.insertions = Number(/(\d+) insertions?/.exec(line)?.[1] ?? 0)
      current.deletions = Number(/(\d+) deletions?/.exec(line)?.[1] ?? 0)
    }
    return entries
  }

  private async hasStagedChanges(): Promise<boolean> {
    const root = await this.requireRoot()
    return git(root, ["diff", "--cached", "--quiet"])
      .then(() => false)
      .catch(() => true)
  }

  private async requireRoot(): Promise<string> {
    const root = this.gitRoot ?? (await findGitRoot(this.cwd))
    this.gitRoot = root
    if (!root) throw new Error("This folder is not a git repository")
    return root
  }

  async pushGit() {
    if (!this.foreground) return
    try {
      this.emit({ type: "git", git: await this.gitStatus() })
    } catch (error) {
      this.notice("error", error)
    }
  }

  /* -------------------------------------------------- teardown */

  private async teardown() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.gitTimer) clearTimeout(this.gitTimer)
    this.flushTimer = null
    this.gitTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.runtime) {
      await this.runtime.dispose()
      this.runtime = null
    }
  }

  async dispose() {
    await this.teardown()
  }
}

/**
 * The default commit-drafting prompt, following Zed's well-tuned wording.
 * Exported so Settings can show it, diff against it, and restore it.
 */
export const COMMIT_PROMPT = `You are an expert at writing Git commits. Your job is to write a short clear commit message that summarizes the changes.

If you can accurately express the change in just the subject line, don't include anything in the message body. Only use the body when it is providing *useful* information.

Don't repeat information from the subject line in the message body.

Only return the commit message in your response. Do not include any additional meta-commentary about the task. Do not include the raw diff output in the commit message.

Follow good Git style:

- Separate the subject from the body with a blank line
- Try to limit the subject line to 50 characters
- Capitalize the subject line
- Do not end the subject line with any punctuation
- Use the imperative mood in the subject line
- Wrap the body at 72 characters
- Keep the body short and concise (omit it entirely if not useful)`

/** Roughly 16k tokens of diff, which every model here can hold comfortably. */
const PATCH_BUDGET = 64_000

/**
 * Trim a patch to a byte budget by shortening the largest file hunks first,
 * so a huge generated file cannot crowd out the change the user cares about.
 */
function truncatePatch(patch: string, maxBytes: number): string {
  if (patch.length <= maxBytes) return patch

  const perFile: string[] = []
  let current = ""
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current) {
      perFile.push(current)
      current = ""
    }
    current += `${line}\n`
  }
  if (current) perFile.push(current)

  const budget = Math.max(600, Math.floor(maxBytes / Math.max(perFile.length, 1)))
  const trimmed = perFile.map((file) =>
    file.length <= budget ? file : `${file.slice(0, budget)}\n… diff truncated …\n`
  )
  return trimmed.join("").slice(0, maxBytes)
}

/** `git diff --numstat -z` emits "adds\tdels\tpath\0"; renames use three fields. */
function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>()
  const fields = output.split("\0")
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field) continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field)
    if (!match) continue
    let path = match[3]
    if (path === "") {
      // Rename: the next two fields are the old path then the new one.
      path = fields[i + 2] ?? fields[i + 1] ?? ""
      i += 2
    }
    stats.set(path, {
      insertions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return stats
}

/** Merge, rebase, and cherry-pick leave marker files in the git dir. */
async function inProgressOperation(root: string): Promise<string | undefined> {
  const gitDir = join(root, ".git")
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge"
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick"
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert"
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase"
  }
  return undefined
}

async function walk(root: string, dir: string, depth: number): Promise<string[]> {
  if (depth > WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(root, full, depth + 1)))
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
    if (out.length > WALK_MAX_FILES) break
  }
  return out
}

async function countLines(path: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > UNTRACKED_STAT_LIMIT) return { lines: 0, binary: false }
    const buf = await readFile(path)
    if (buf.includes(0)) return { lines: 0, binary: true }
    if (buf.length === 0) return { lines: 0, binary: false }
    let lines = 1
    for (const byte of buf) if (byte === 10) lines += 1
    return { lines, binary: false }
  } catch {
    return { lines: 0, binary: false }
  }
}

export function defaultWorkspace(): string {
  const home = homedir()
  const candidates = [join(home, "mako"), join(home, "pi-ui"), home]
  return candidates.find((path) => existsSync(path)) ?? home
}

export function relativeTo(cwd: string, path: string) {
  return relative(cwd, path) || path
}
