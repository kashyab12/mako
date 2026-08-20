import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent"
import { WorkspaceGit } from "./host-git.js"
import { searchWorkspace } from "./host-search.js"
import {
  serializeMessage,
  serializeTree,
  thinkingLevelsFor,
  toModelInfo,
} from "./host-serialization.js"
import { WorkspaceFiles } from "./host-workspace.js"
import type {
  Capabilities,
  ChatMessage,
  ContextUsage,
  FileContents,
  GitCommitEntry,
  GitDiff,
  GitFileStatus,
  GitStatus,
  HostEvent,
  ModelInfo,
  SessionMeta,
  SessionState,
  SessionSummary,
  SearchOptions,
  SearchResults,
  StagedFile,
  ThinkingLevel,
  ToolSummary,
  WorkspaceFile,
} from "./shared.js"

/** Run a reader that may throw, falling back rather than failing the caller. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
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
 * above it names the implementation, so swapping the runtime is a local change.
 */
export class AgentHost {
  readonly id: string
  private runtime: AgentSessionRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private emit: (event: HostEvent) => void
  private readonly workspaceGit: WorkspaceGit
  private readonly workspaceFiles: WorkspaceFiles

  /** Coalescing state — the hot path batches into one emission per frame. */
  private pending = { meta: false, messages: false, tree: false, stream: false }
  private flushTimer: NodeJS.Timeout | null = null
  private gitTimer: NodeJS.Timeout | null = null
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
    const cwd = homedir()
    this.id = id
    this.emit = (event) => emit({ ...event, tabId: id })
    this.workspaceGit = new WorkspaceGit(cwd)
    this.workspaceFiles = new WorkspaceFiles(cwd, this.workspaceGit)
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
    return this.workspaceFiles.cwd
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

  private setWorkspace(cwd: string) {
    this.workspaceGit.setCwd(cwd)
    this.workspaceFiles.setCwd(cwd)
  }

  async start(cwd = this.workspace) {
    this.setWorkspace(cwd)
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
    await this.workspaceGit.root()
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
      if (stream)
        this.emit({ type: "stream", message: this.streamingMessage() })
      if (messages) this.emit({ type: "messages", messages: this.messages() })
      if (tree) {
        const leafId = this.session.sessionManager.getLeafId()
        this.emit({ type: "tree", tree: serializeTree(this.session.sessionManager.getTree(), leafId), leafId })
      }
      if (meta) this.emit({ type: "meta", meta: this.meta() })
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error))
    }
  }

  private scheduleGit() {
    if (this.gitTimer) return
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null
      void this.pushGit()
    }, 350)
  }

  private notice(level: "info" | "success" | "error", message: string) {
    this.emit({ type: "notice", level, message })
  }

  /* -------------------------------------------------- reads */

  private streamingMessage(): ChatMessage | null {
    const message = this.session.state.streamingMessage
    if (!message) return null
    return { ...serializeMessage(message, "draft"), streaming: true }
  }

  messages(): ChatMessage[] {
    return this.session.messages.map((message, index) => serializeMessage(message, `m${index}`))
  }

  meta(): SessionMeta {
    const session = this.session
    const manager = session.sessionManager
    const model = session.model
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
      cwd: this.workspace,
      leafId: manager.getLeafId(),
      model: model ? toModelInfo(model) : undefined,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: model ? thinkingLevelsFor(model) : ["off"],
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
    this.emit({ type: "session", session: this.state() })
    this.emit({ type: "stream", message: this.streamingMessage() })
  }

  /* -------------------------------------------------- sessions */

  /**
   * Sessions for the rail. `scope: "all"` reaches across every project the
   * engine has run in, which makes the rail a way to move between projects
   * rather than only within the current one.
   */
  async listSessions(
    cwd = this.workspace,
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
    this.setWorkspace(this.session.sessionManager.getCwd() || this.workspace)
    await this.workspaceGit.root()
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
      const options: PromptOptions = { streamingBehavior: mode ?? "steer" }
      if (attachments) options.images = attachments
      await session.prompt(text, options)
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
  async fork(entryId: string, position: "before" | "at" = "before") {
    if (!this.runtime) throw new Error("The agent is not ready yet")
    const result = await this.runtime.fork(entryId, { position })
    if (result.cancelled) return { cancelled: true as const }
    this.setWorkspace(this.session.sessionManager.getCwd() || this.workspace)
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
      .map((model) => toModelInfo(model))
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
          source: tool.sourceInfo.source,
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
      this.notice("error", error instanceof Error ? error.message : String(error))
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
    return this.workspaceGit.status()
  }

  async listFiles(): Promise<WorkspaceFile[]> {
    return this.workspaceFiles.list()
  }

  async stageFile(name: string, base64: string): Promise<StagedFile> {
    return this.workspaceFiles.stage(name, base64)
  }

  async stageFilePath(sourcePath: string): Promise<StagedFile> {
    return this.workspaceFiles.stagePath(sourcePath)
  }

  /* -------------------------------------------------- search */

  async search(query: string, options: SearchOptions = {}): Promise<SearchResults> {
    return searchWorkspace(
      this.workspace,
      this.workspaceGit,
      (cwd, scope) => this.listSessions(cwd, scope),
      query,
      options
    )
  }

  async readWorkspaceFile(path: string): Promise<FileContents> {
    return this.workspaceFiles.read(path)
  }

  async resolvePath(path: string): Promise<string> {
    return this.workspaceFiles.resolvePath(path)
  }

  async gitDiff(path: string): Promise<GitDiff> {
    return this.workspaceGit.diff(path)
  }

  async gitCommitFiles(
    hash: string
  ): Promise<Array<{ path: string; status: GitFileStatus; insertions: number; deletions: number; binary: boolean }>> {
    return this.workspaceGit.commitFiles(hash)
  }

  async gitCommitDiffAll(hash: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return this.workspaceGit.commitDiffAll(hash)
  }

  async gitCommitFileDiff(hash: string, path: string): Promise<GitDiff> {
    return this.workspaceGit.commitFileDiff(hash, path)
  }

  /* -------------------------------------------------- git operations */

  async gitStage(paths: string[]) {
    await this.workspaceGit.stage(paths)
    await this.pushGit()
  }

  async gitUnstage(paths: string[]) {
    await this.workspaceGit.unstage(paths)
    await this.pushGit()
  }

  async gitStageAll() {
    await this.workspaceGit.stageAll()
    await this.pushGit()
  }

  async gitUnstageAll() {
    await this.workspaceGit.unstageAll()
    await this.pushGit()
  }

  async gitPatch(staged: boolean): Promise<string> {
    return this.workspaceGit.patch(staged)
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

    const staged = await this.workspaceGit.hasStagedChanges()
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

    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")

    const message = text.trim()
    if (!message) throw new Error("The model returned an empty message")
    return message
  }

  async gitCommit(message: string, options: { amend?: boolean } = {}) {
    await this.workspaceGit.commit(message, options)
    await this.pushGit()
    this.emit({ type: "notice", level: "success", message: "Committed" })
  }

  async gitPush(): Promise<void> {
    const { branch, output } = await this.workspaceGit.push()
    await this.pushGit()
    this.emit({
      type: "notice",
      level: "success",
      message: output.trim().split("\n").at(-1) || `Pushed ${branch}`,
    })
  }

  async gitLog(limit = 60): Promise<GitCommitEntry[]> {
    return this.workspaceGit.log(limit)
  }

  async pushGit() {
    if (!this.foreground) return
    try {
      this.emit({ type: "git", git: await this.gitStatus() })
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error))
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

export function defaultWorkspace(): string {
  const home = homedir()
  const candidates = [join(home, "mako"), join(home, "pi-ui"), home]
  return candidates.find((path) => existsSync(path)) ?? home
}

export function relativeTo(cwd: string, path: string) {
  return relative(cwd, path) || path
}
