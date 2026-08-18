import type {
  BootPayload,
  Capabilities,
  GitStatus,
  HostEvent,
  ModelInfo,
  PiMessage,
  SessionMeta,
  SessionSummary,
  TreeNode,
} from "@/lib/types"

/**
 * A fake agent host for design work.
 *
 * Load the dev server with `?mock` and the desk boots against fixtures instead
 * of a real agent, so layout, density, and motion can be judged in a browser
 * without spending tokens. Dev-only; never bundled into a production build.
 */

const MODELS: ModelInfo[] = [
  m("anthropic", "claude-opus-5", "Claude Opus 5", 1_000_000, 64_000, true, 5, 25, true),
  m("anthropic", "claude-sonnet-5", "Claude Sonnet 5", 400_000, 64_000, true, 3, 15, true),
  m("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 32_000, false, 0.8, 4, true),
  m("openai", "gpt-5.2", "GPT-5.2", 400_000, 100_000, true, 1.25, 10, true),
  m("openai", "o5-mini", "o5-mini", 200_000, 65_000, true, 1.1, 4.4, false),
  m("google", "gemini-3-pro", "Gemini 3 Pro", 2_000_000, 65_000, true, 1.25, 10, true),
  m("deepseek", "deepseek-v4", "DeepSeek V4", 128_000, 8_000, true, 0.27, 1.1, false),
  m("zai", "glm-5", "GLM-5", 200_000, 32_000, true, 0.6, 2.2, false),
]

function m(
  provider: string,
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  deepThinking: boolean,
  input: number,
  output: number,
  vision: boolean
): ModelInfo {
  return {
    provider,
    id,
    name,
    reasoning: true,
    thinkingLevels: deepThinking
      ? ["off", "low", "medium", "high", "xhigh", "max"]
      : ["off", "low", "medium", "high"],
    contextWindow,
    maxTokens,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
  }
}

const MESSAGES: PiMessage[] = [
  {
    id: "m0",
    role: "user",
    timestamp: Date.now() - 900_000,
    blocks: [
      {
        type: "text",
        text: "The session rail re-renders on every streamed token. Find out why and fix it.",
      },
    ],
  },
  {
    id: "m1",
    role: "assistant",
    timestamp: Date.now() - 880_000,
    model: "claude-opus-5",
    blocks: [
      {
        type: "thinking",
        thinking:
          "A rail that repaints on every token almost always means one of two things: the list is subscribed to the whole session object, or the row components are not memoized and their props are recreated each render. Worth checking the store's read path first.",
      },
      { type: "text", text: "Let me look at how the rail reads from the store." },
      {
        type: "toolCall",
        id: "t1",
        name: "grep",
        arguments: { pattern: "useSession", path: "src/components/rail" },
      },
      {
        type: "toolResult",
        id: "t1",
        name: "grep",
        text: "src/components/rail/session-rail.tsx:24:  const snapshot = useSession((state) => state)\nsrc/components/rail/session-rail.tsx:31:  const sessions = snapshot.sessions",
      },
      {
        type: "text",
        text: "There it is. The rail selects the **entire store object**, so any change — including the streaming message — invalidates it.\n\nThe fix is to select only the two slices the rail actually reads:",
      },
      {
        type: "toolCall",
        id: "t2",
        name: "edit",
        arguments: {
          file_path: "src/components/rail/session-rail.tsx",
          edits: [
            {
              oldText:
                "  const snapshot = useSession((state) => state)\n  const sessions = snapshot.sessions\n  const activePath = snapshot.meta?.sessionFile",
              newText:
                "  const sessions = useSession((state) => state.sessions)\n  const activePath = useSession((state) => state.meta?.sessionFile)",
            },
          ],
        },
      },
      {
        type: "toolResult",
        id: "t2",
        name: "edit",
        text: "Applied 1 edit to src/components/rail/session-rail.tsx",
      },
      {
        type: "toolCall",
        id: "t3",
        name: "bash",
        arguments: { command: "npx tsc --noEmit -p tsconfig.app.json" },
      },
      { type: "toolResult", id: "t3", name: "bash", text: "" },
      {
        type: "text",
        text: "Typecheck is clean. The rail now re-renders only when the session list or the active file changes — streaming tokens no longer touch it.\n\n```ts\nconst sessions = useSession((state) => state.sessions)\n```\n\nWorth checking the status bar for the same pattern; it reads five scalars and could collapse them into one shallow-compared selector.",
      },
    ],
  },
]

const TREE: TreeNode[] = [
  {
    id: "n0",
    parentId: null,
    type: "message",
    preview: "The session rail re-renders on every streamed token…",
    role: "user",
    onPath: true,
    timestamp: new Date(Date.now() - 900_000).toISOString(),
    childIds: ["n1"],
  },
  {
    id: "n1",
    parentId: "n0",
    type: "message",
    preview: "There it is. The rail selects the entire store object…",
    role: "assistant",
    onPath: true,
    timestamp: new Date(Date.now() - 880_000).toISOString(),
    childIds: ["n2", "n3"],
  },
  {
    id: "n2",
    parentId: "n1",
    type: "message",
    preview: "Now do the same audit on the status bar",
    role: "user",
    onPath: false,
    timestamp: new Date(Date.now() - 600_000).toISOString(),
    childIds: [],
  },
  {
    id: "n3",
    parentId: "n1",
    type: "message",
    preview: "Actually, revert that and use a shallow comparator instead",
    role: "user",
    onPath: true,
    timestamp: new Date(Date.now() - 500_000).toISOString(),
    childIds: [],
  },
]

const META: SessionMeta = {
  sessionId: "mock-session",
  sessionFile: "/tmp/sessions/rail-perf.jsonl",
  sessionName: "Rail re-render audit",
  cwd: "/Users/you/mako",
  leafId: "n3",
  model: MODELS[0],
  thinkingLevel: "high",
  thinkingLevels: MODELS[0].thinkingLevels,
  isStreaming: false,
  isIdle: true,
  isCompacting: false,
  isRetrying: false,
  isBashRunning: false,
  autoCompaction: true,
  queued: { steering: [], followUp: [] },
  cost: 0.4271,
  tokens: { input: 128_400, output: 9_120, cacheRead: 96_000, cacheWrite: 12_000, total: 245_520 },
  context: { tokens: 141_200, contextWindow: 1_000_000, percent: 14.1 },
  messageCount: MESSAGES.length,
}

const GIT: GitStatus = {
  cwd: META.cwd,
  root: META.cwd,
  branch: "desk-refactor",
  ahead: 2,
  behind: 0,
  files: [
    { path: "src/components/rail/session-rail.tsx", status: "modified", insertions: 12, deletions: 9, binary: false, staged: false },
    { path: "src/state/store.ts", status: "modified", insertions: 41, deletions: 3, binary: false, staged: true },
    { path: "src/components/shell/status-bar.tsx", status: "added", insertions: 88, deletions: 0, binary: false, staged: false },
    { path: "src/components/desk/chat-pane.tsx", status: "deleted", insertions: 0, deletions: 234, binary: false, staged: false },
  ],
}

function sessions(): SessionSummary[] {
  const now = Date.now()
  const make = (name: string, first: string, agoMinutes: number, count: number): SessionSummary => ({
    path: `/tmp/sessions/${name.toLowerCase().replace(/\W+/g, "-")}.jsonl`,
    id: name,
    cwd: META.cwd,
    name,
    created: new Date(now - agoMinutes * 60_000).toISOString(),
    modified: new Date(now - agoMinutes * 60_000).toISOString(),
    messageCount: count,
    firstMessage: first,
  })
  return [
    make("Rail re-render audit", "The session rail re-renders on every streamed token", 4, 12),
    make("Composer autogrow", "The textarea jumps a frame when it grows", 55, 8),
    make("Model picker keyboard nav", "Arrow keys should move through grouped results", 190, 21),
    make("Git status is slow", "Reading every file on each event is too expensive", 1_500, 34),
    make("Theme tokens", "Pull the palette into one place", 4_400, 6),
    make("Drop the bubbles", "Chat bubbles are wrong for a coding agent", 12_000, 17),
  ]
}

export function installMockBridge() {
  const listeners = new Set<(event: HostEvent) => void>()
  const emit = (event: HostEvent) => listeners.forEach((listener) => listener(event))
  let meta = { ...META }

  const capabilities: Capabilities = {
    tools: [
      { name: "read", description: "Read a file from disk", active: true },
      { name: "edit", description: "Replace exact text in a file", active: true },
      { name: "write", description: "Create or overwrite a file", active: true },
      { name: "bash", description: "Run a shell command in the workspace", active: true },
      { name: "grep", description: "Search file contents by regex", active: true },
      { name: "find", description: "Find files by glob pattern", active: true },
      { name: "ls", description: "List a directory", active: false },
    ],
    commands: [
      { name: "compact", description: "Summarize history to free context" },
      { name: "model", description: "Switch the active model" },
      { name: "cost", description: "Show token spend for this session" },
      { name: "export", description: "Write this session to HTML" },
      { name: "tree", description: "Jump to another point in the session tree" },
    ],
    skills: [
      { name: "review-diff", description: "Read the working tree and report defects with severities." },
      { name: "write-tests", description: "Generate tests for changed code paths, matching the repo's style." },
    ],
  }

  const boot: BootPayload = {
    tabs: [{ id: "tab-1", session: { meta, messages: MESSAGES, tree: TREE }, git: GIT, capabilities }],
    activeTabId: "tab-1",
    models: MODELS,
    platform: "darwin",
  }

  const update = (patch: Partial<SessionMeta>) => {
    meta = { ...meta, ...patch }
    emit({ type: "meta", meta })
  }

  // Tabs in the browser mock are cosmetic: there is no second runtime to run,
  // so a new tab is another view of the same fixture. Enough to lay out the
  // strip against, not enough to pretend it is the real thing.
  let tabCount = 1
  const mockTab = (id: string) => ({
    id,
    session: { meta, messages: MESSAGES, tree: TREE },
    git: GIT,
    capabilities,
  })

  window.pi = {
    boot: async () => boot,
    openTab: async () => mockTab(`tab-${++tabCount}`),
    closeTab: async (id: string) => ({ tabs: [id], activeId: "tab-1" }),
    activateTab: async () => true,
    fork: async () => ({ cancelled: false as const, text: "", tab: mockTab(`tab-${++tabCount}`) }),
    listSessions: async () => sessions(),
    openSession: async () => ({ meta, messages: MESSAGES, tree: TREE }),
    newSession: async () => ({ meta, messages: [], tree: [] }),
    setCwd: async () => ({ meta, messages: MESSAGES, tree: TREE }),
    setName: async (name: string) => update({ sessionName: name }),
    prompt: async () => {
      update({ isStreaming: true, isIdle: false })
      emit({
        type: "stream",
        message: { id: "draft", role: "assistant", streaming: true, blocks: [] },
      })
      setTimeout(() => {
        emit({
          type: "stream",
          message: {
            id: "draft",
            role: "assistant",
            streaming: true,
            blocks: [{ type: "text", text: "Working on it…" }],
          },
        })
      }, 400)
      setTimeout(() => {
        emit({ type: "stream", message: null })
        update({ isStreaming: false, isIdle: true })
      }, 2400)
    },
    abort: async () => update({ isStreaming: false, isIdle: true }),
    clearQueue: async () => update({ queued: { steering: [], followUp: [] } }),
    navigateTree: async () => ({ meta, messages: MESSAGES, tree: TREE }),
    compact: async () => update({ isCompacting: false }),
    setAutoCompaction: async (enabled: boolean) => update({ autoCompaction: enabled }),
    listModels: async () => MODELS,
    setModel: async (provider: string, id: string) => {
      const model = MODELS.find((entry) => entry.provider === provider && entry.id === id)
      if (model) update({ model, thinkingLevels: model.thinkingLevels })
    },
    setThinking: async (level) => update({ thinkingLevel: level }),
    capabilities: async () => capabilities,
    setActiveTools: async () => {},
    runCommand: async () => {},
    search: async (query: string) => ({
      query,
      files: [{ path: "src/state/session.ts", lines: [{ line: 1, text: `// ${query}` }], more: 0 }],
      threads: [],
      total: 1,
      truncated: false,
      elapsed: 3,
    }),
    readFile: async (path: string) => ({
      path,
      contents: `// ${path}\n// The browser mock has no filesystem; this stands in for one.\n`,
      size: 96,
      binary: false,
      truncated: false,
    }),
    listFiles: async () => [
      "src/components/composer/composer.tsx",
      "src/components/rail/session-rail.tsx",
      "src/components/transcript/turn.tsx",
      "src/state/store.ts",
      "src/state/session.ts",
      "src/index.css",
      "electron/host.ts",
      "electron/shared.ts",
      "package.json",
      "README.md",
    ].map((path) => ({ path, changed: GIT.files.some((file) => file.path === path) })),

    gitStage: async () => {},
    gitUnstage: async () => {},
    gitStageAll: async () => {},
    gitUnstageAll: async () => {},
    gitCommit: async () => {},
    gitPush: async () => {},
    gitCommitFiles: async () => [
      { path: "src/state/store.ts", status: "modified" as const, insertions: 41, deletions: 3, binary: false },
      { path: "src/components/rail/session-rail.tsx", status: "modified" as const, insertions: 12, deletions: 9, binary: false },
    ],
    gitCommitFileDiff: async (_hash: string, path: string) => ({
      path,
      binary: false,
      oldFile: { name: path, contents: "const before = 1\n" },
      newFile: { name: path, contents: "const after = 2\n" },
    }),
    gitLog: async () => [
      { hash: "a1", shortHash: "a1b2c3d", subject: "Reconcile message identity across host updates", author: "You", date: new Date(Date.now() - 3_600_000).toISOString(), files: 3, insertions: 88, deletions: 12 },
      { hash: "b2", shortHash: "e4f5a6b", subject: "Group the transcript by exchange", author: "You", date: new Date(Date.now() - 9_000_000).toISOString(), files: 6, insertions: 240, deletions: 190 },
      { hash: "c3", shortHash: "c7d8e9f", subject: "Drop the brand hue for an achromatic ramp", author: "You", date: new Date(Date.now() - 86_400_000).toISOString(), files: 2, insertions: 41, deletions: 33 },
    ],
    generateCommitMessage: async () =>
      "Reserve a gutter for the turn navigator\n\nThe navigator was absolutely positioned over the transcript, so on a\nnarrow pane its ticks sat on top of the prose.",

    stageFile: async (name: string) => ({ path: `/tmp/pi-attachments/${name}`, name, size: 0 }),
    defaultCommitPrompt: async () => "You are an expert at writing Git commits.",

    gitStatus: async () => GIT,
    gitDiff: async (path: string) => ({
      path,
      binary: false,
      oldFile: { name: path, contents: "const sessions = useSession((state) => state)\n" },
      newFile: { name: path, contents: "const sessions = useSession((state) => state.sessions)\n" },
    }),
    listPlugins: async () => [
      {
        id: "thread-counter",
        source: "export function setup(){ mako.registerSlot('rail.footer', () => React.createElement('div', { style: { padding: '6px 10px', fontSize: 10.5, opacity: 0.5 } }, 'plugin: ' + mako.threads.read().threads.length + ' threads')) }",
      },
      { id: "broken-example", source: "export function setup(){ throw new Error('deliberate failure for the demo') }" },
    ],
    pluginsDir: async () => "/tmp/mako/plugins",
    writePlugin: async () => {},
    deletePlugin: async () => {},
    revealPlugins: async () => {},
    githubStatus: async () => ({ installed: true, authenticated: true, login: "you", repo: "you/mako", defaultBranch: "main" }),
    pullRequest: async () => null,
    pullRequests: async () => [],
    createPull: async () => null,
    rerunChecks: async () => {},
    repoAvatar: async () => undefined,
    openUrl: async () => {},
    threads: async () => ({ ready: true, threads: [
      { harness: "codex", nativeId: "cx-1", path: "/mock/codex.jsonl", cwd: "/Users/you/api", title: "Trace the flaky webhook retry", model: "gpt-5.2-codex", updatedAt: new Date(Date.now() - 1_200_000).toISOString(), startedAt: new Date(Date.now() - 5_200_000).toISOString(), bytes: 20_000 },
      { harness: "claude", nativeId: "cl-1", path: "/mock/claude.jsonl", cwd: "/Users/you/mako", title: "Refactor the composer focus handling", model: "claude-opus-5", updatedAt: new Date(Date.now() - 4_800_000).toISOString(), startedAt: new Date(Date.now() - 9_800_000).toISOString(), bytes: 48_000 },
      { harness: "cursor", nativeId: "cu-1", path: "/mock/cursor.db", cwd: "/Users/you/site", title: "Make the pricing table responsive", updatedAt: new Date(Date.now() - 86_000_000).toISOString(), startedAt: new Date(Date.now() - 90_000_000).toISOString(), bytes: 12_000 },
      { harness: "claude", nativeId: "cl-2", path: "/mock/claude-2.jsonl", cwd: "/Users/you/api", title: "Ship the billing webhooks", model: "claude-opus-5", updatedAt: new Date(Date.now() - 600_000).toISOString(), startedAt: new Date(Date.now() - 2_000_000).toISOString(), bytes: 9_000, lineage: [{ harness: "devin", title: "Ship the billing webhooks" }] },
    ] }),
    openThread: async (path: string) => ({
      ref: path.includes("claude-2")
        ? { harness: "claude" as const, nativeId: "cl-2", path, cwd: "/Users/you/api", title: "Ship the billing webhooks", model: "claude-opus-5", updatedAt: new Date().toISOString(), lineage: [{ harness: "devin" as const, title: "Ship the billing webhooks" }] }
        : { harness: "codex" as const, nativeId: "cx-1", path, cwd: "/Users/you/api", title: "Trace the flaky webhook retry", model: "gpt-5.2-codex", updatedAt: new Date().toISOString() },
      entries: [
        { kind: "user", text: "The webhook retry is flaky under load — trace it." },
        { kind: "assistant", blocks: [
          { type: "thinking", text: "Look at the queue consumer first." },
          { type: "tool", name: "shell", input: "rg 'retry' src/queue", output: "src/queue/consumer.ts:42" },
          { type: "text", text: "The retry drops the idempotency key on the second attempt. Fixing." },
        ] },
      ],
    }),
    continueThread: async () => {
      throw new Error("The browser mock cannot open tabs")
    },
    emitThreadToClaude: async () => ({ sessionId: "mock-claude-session" }),
    accounts: async () => [
      { harness: "claude" as const, name: "default", dir: "~/.claude", active: true },
      { harness: "claude" as const, name: "work", dir: "~/.mako/accounts/claude/work", active: false },
      { harness: "codex" as const, name: "default", dir: "~/.codex", active: false },
      { harness: "codex" as const, name: "personal", dir: "~/.mako/accounts/codex/personal", active: true },
    ],
    captureAccount: async () => {},
    selectAccount: async () => {},
    removeAccount: async () => {},
    accountUsage: async (harness: string, name: string) =>
      harness === "codex"
        ? { status: "ok" as const, plan: "pro", session: { usedPercent: 34, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 }, weekly: { usedPercent: 92, windowMinutes: 10_080, resetsAt: Date.now() + 4 * 86_400_000 } }
        : name === "default"
          ? { status: "stale-token" as const, detail: "Refreshes the next time Claude Code runs" }
          : { status: "ok" as const, session: { usedPercent: 12, windowMinutes: 300, resetsAt: Date.now() + 9_000_000 }, weekly: { usedPercent: 55, windowMinutes: 10_080, resetsAt: Date.now() + 2 * 86_400_000 } },
    devinAccounts: async () => [{ name: "work", key: "apk_…f3a1" }],
    saveDevinAccounts: async () => {},
    harnessAvailability: async () => ({ pi: true, codex: true, claude: true, cursor: true, grok: false }),
    daemonStatus: async () => ({ pid: 4242, startedAt: Date.now() - 7_200_000, sessions: 414 }),
    followThread: async () => {},
    unfollowThread: async () => {},
    resumableHarnesses: async () => ["codex", "claude", "cursor", "grok"],
    acpHarnesses: async () => ["claude", "cursor"],
    acpStart: async (harness: string, cwd: string) => ({ id: "acp-1", harness, cwd, status: "ready" as const, modes: [{ id: "default", name: "Always Ask" }, { id: "acceptEdits", name: "Accept Edits" }], currentMode: "default" }),
    acpPrompt: async () => {},
    acpPermission: async () => {},
    acpSetMode: async () => {},
    acpCancel: async () => {},
    acpClose: async () => {},
    continueTargets: async () => ["pi", "codex", "claude", "cursor", "grok"],
    continueThreadWith: async (_path: string, harness: string) =>
      harness === "claude" || harness === "codex"
        ? { kind: "emitted" as const, path: `/mock/emitted-${harness}.jsonl` }
        : { kind: "spawned" as const, run: { path: `fresh:${harness}:1`, harness, status: "running" as const } },
    threadRun: async () => null,
    resumeThread: async (path: string) => ({ path, harness: "codex", status: "running" as const }),
    abortThreadRun: async () => {},
    usage: async () => ({
      total: { cost: 36.63, input: 2_400_000, output: 180_000, cacheRead: 9_100_000, cacheWrite: 210_000, messages: 285 },
      days: [], models: [], projects: [], sessions: 12, truncated: false,
    }),
    automations: async () => [
      { id: "a1", name: "Check the schema doc", prompt: "A migration changed. Check docs/schema.md still matches.", trigger: "files" as const, paths: ["migrations/*.sql"], enabled: false },
    ],
    saveAutomations: async (next: unknown) => next as never,
    setAutomationEnabled: async () => [],
    runAutomation: async () => {},
    reloadAutomations: async () => [],
    ports: async () => [
      { port: 5173, pid: 1, command: "node", url: "http://localhost:5173", loopbackOnly: true, likely: true },
      { port: 8787, pid: 2, command: "python3", url: "http://localhost:8787", loopbackOnly: true, likely: true },
    ],
    devScripts: async () => ["dev", "desktop", "build"],
    devState: async () => ({ status: "idle" as const, lines: [] }),
    devStart: async (script: string) => ({ status: "starting" as const, script, lines: [] }),
    devStop: async () => ({ status: "idle" as const, lines: [] }),
    devAttach: async (url: string) => ({ status: "running" as const, url, lines: [] }),
    updateState: async () => ({ status: "unsupported" as const, version: "0.0.0-mock" }),
    checkUpdates: async () => ({ status: "unsupported" as const, version: "0.0.0-mock" }),
    installUpdate: async () => {},
    crashes: async () => [],
    crashesDir: async () => "/tmp/mako/crashes",
    clearCrashes: async () => {},
    reportCrash: async () => {},
    pickFolder: async () => null,
    revealPath: async () => {},
    copy: async () => {},
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
