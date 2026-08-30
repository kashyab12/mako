import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  clampCompanionWidth,
  clampDockHeight,
  fitsBeside,
} from "../src/components/stage/stage-width.ts"
import {
  argAt,
  isSubagentLaunch,
  subagentResultId,
  subagentResultText,
  summarizeToolWork,
  toolLabel,
} from "../src/lib/tools.ts"
import {
  activeThreadRefs,
  applyThreadRun,
  markThreadReviewed,
  recentThreadActivityDuration,
  threadStatus,
  threadStatusPriority,
  threadsStore,
  uniqueThreadRefs,
} from "../src/state/threads.ts"
import { cacheOf, dropCache, writeCache } from "../src/state/tabs.ts"
import {
  appendOptimisticReply,
  bindQueuedReplySender,
  releaseQueuedReply,
  removeOptimisticReply,
} from "../src/state/thread-queue.ts"
import {
  groupThreadFolders,
  threadBelongsToWorkspace,
  threadFolderKey,
} from "../src/lib/thread-folders.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import { contextAccounting } from "../src/lib/context-accounting.ts"
import { runningTerminalForWorkspace } from "../src/state/terminal.ts"
import { workspaceFocusOf } from "../src/components/stage/workspace-focus-context.ts"
import {
  composerActionKind,
  composerTurnRunning,
} from "../src/lib/composer-action.ts"
import { responseSections } from "../src/lib/exchanges.ts"
import {
  pendingThreadInput,
  threadToMessages,
} from "../src/lib/foreign-thread.ts"
import {
  acp,
  acpStore,
  applyAcpPermission,
  applyAcpSession,
  applyAcpUpdates,
  type LiveAcpConversation,
} from "../src/state/acp.ts"
import {
  sameAcpPresence,
  selectAcpPresence,
} from "../src/state/acp-presence.ts"
import type {
  ChatMessage,
  HarnessProfile,
  TerminalSession,
  Thread,
  ThreadEntry,
  ThreadRef,
} from "../src/lib/types.ts"

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
assert.doesNotMatch(css, /\binfinite\b/)
assert.equal(
  composerActionKind({ running: false, hasContent: false }),
  "send"
)
assert.equal(
  composerActionKind({ running: false, hasContent: true }),
  "send"
)
assert.equal(
  composerActionKind({ running: true, hasContent: false }),
  "stop"
)
assert.equal(
  composerActionKind({ running: true, hasContent: true }),
  "queue"
)
assert.equal(
  composerTurnRunning({
    builtinRunning: false,
    livePresent: true,
    liveRunning: true,
    liveThreadPath: "/live",
    viewingPath: "/live",
    viewingRunning: false,
  }),
  true
)
assert.equal(
  composerTurnRunning({
    builtinRunning: false,
    livePresent: true,
    liveRunning: true,
    liveThreadPath: "/live",
    viewingPath: "/other",
    viewingRunning: false,
  }),
  false
)

assert.deepEqual(
  workspaceFocusOf({
    sessionCwd: "/repo/mako",
    sessionTitle: "Mako",
    viewing: {
      path: "/sessions/arca.jsonl",
      cwd: "/repo/arca",
      title: "Arca audit",
    },
  }),
  {
    cwd: "/repo/arca",
    title: "Arca audit",
    identity: "thread:/sessions/arca.jsonl",
    ready: false,
  }
)
assert.deepEqual(
  workspaceFocusOf({
    sessionCwd: "/repo/arca",
    viewing: { path: "/sessions/arca.jsonl", cwd: "/repo/arca" },
    live: { id: "live-1", cwd: "/repo/arca", title: "Live arca" },
    liveThreadPath: "/sessions/arca.jsonl",
  }),
  {
    cwd: "/repo/arca",
    title: "Live arca",
    identity: "live:live-1",
    ready: true,
  }
)

const duplicateThreadBase: ThreadRef = {
  harness: "codex",
  nativeId: "parent-session",
  path: "/sessions/parent.jsonl",
  cwd: "/repo/arca",
  updatedAt: "2026-08-25T01:00:00.000Z",
}
assert.deepEqual(
  uniqueThreadRefs([
    duplicateThreadBase,
    {
      ...duplicateThreadBase,
      path: "/sessions/subagent.jsonl",
      updatedAt: "2026-08-25T01:01:00.000Z",
    },
  ]).map((ref) => `${ref.harness}:${ref.nativeId}`),
  ["codex:parent-session"]
)

const terminalSession = (
  id: string,
  cwd: string,
  status: TerminalSession["status"]
): TerminalSession => ({
  id,
  cwd,
  status,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  cols: 80,
  rows: 24,
  sequence: 0,
})
const restoredTerminals = [
  terminalSession("dead-current", "/repo/a", "exited"),
  terminalSession("live-other", "/repo/b", "running"),
]
assert.equal(runningTerminalForWorkspace(restoredTerminals, "/repo/a"), undefined)
assert.equal(
  runningTerminalForWorkspace(restoredTerminals, "/repo/b")?.id,
  "live-other"
)

for (const id of ["perf-a", "perf-b", "perf-c"]) {
  writeCache(id, {
    messages: [{ id, role: "user", blocks: [{ type: "text", text: id }] }],
  })
}
assert.deepEqual(cacheOf("perf-a").messages, [])
for (const id of ["perf-a", "perf-b", "perf-c"]) dropCache(id)

assert.equal(
  clampCompanionWidth({ width: 520, available: 1400, min: 400 }),
  520
)
assert.equal(
  clampCompanionWidth({ width: 520, available: 800, min: 400 }),
  400
)
assert.equal(fitsBeside(851, 400), true)
assert.equal(fitsBeside(850, 400), false)
assert.equal(
  clampDockHeight({ height: 280, available: 900, min: 180 }),
  280
)
assert.equal(
  clampDockHeight({ height: 600, available: 500, min: 180 }),
  240
)
assert.equal(
  clampDockHeight({ height: 120, available: 300, min: 180 }),
  180
)
assert.equal(
  clampDockHeight({ height: 350, available: undefined, min: 180 }),
  350
)

const subagentEnvelope =
  '<subagent sessionID="ses_test" state="completed"> mako </subagent>'
assert.equal(subagentResultId(subagentEnvelope), "ses_test")
assert.equal(subagentResultText(subagentEnvelope), "mako")
assert.equal(
  subagentResultText("<task_result>finished cleanly</task_result>"),
  "finished cleanly"
)
assert.equal(
  subagentResultText("<task_error>failed cleanly</task_error>"),
  "failed cleanly"
)
assert.equal(
  subagentResultText('<subagent sessionID="ses_partial">'),
  "Subagent result was incomplete."
)
assert.equal(argAt('{"description":"Read package name"}', "description"), "Read package name")
assert.equal(
  isSubagentLaunch({ id: "1", name: "TaskUpdate", pending: false }),
  false
)
assert.equal(
  isSubagentLaunch({ id: "2", name: "Subagent", pending: true }),
  true
)
assert.equal(toolLabel("exec_command"), "Shell")
assert.equal(toolLabel("TaskUpdate"), "Update task")
assert.deepEqual(
  summarizeToolWork([
    { id: "edit-a", name: "edit", arguments: { file_path: "src/a.ts" }, pending: false },
    { id: "edit-a-2", name: "write", arguments: { path: "src/a.ts" }, pending: false },
    { id: "shell", name: "exec_command", pending: false },
    { id: "read", name: "read", pending: false },
    { id: "search", name: "grep", pending: false },
    { id: "skill", name: "skill", pending: false },
    { id: "agent", name: "run_subagent", pending: false },
    { id: "plan", name: "TodoWrite", pending: false, isError: true },
  ]),
  {
    tools: 8,
    changedFiles: 1,
    commands: 1,
    reads: 1,
    searches: 1,
    skills: 1,
    agents: 1,
    plans: 1,
    other: 0,
    failed: 1,
  }
)

const acpConversation = acpBlocksToMessages(
  [
    { type: "user", text: "Inspect it" },
    { type: "thinking", text: "Checking" },
    {
      type: "tool",
      id: "tool-1",
      title: "Read file",
      toolKind: "read_file",
      status: "completed",
      input: '{"path":"README.md"}',
      output: "Mako",
    },
    { type: "text", text: "Done" },
    {
      type: "plan",
      entries: [{ content: "Inspect", status: "completed" }],
    },
  ],
  true,
  "cursor"
)
assert.deepEqual(
  acpConversation.messages.map((message) => message.role),
  ["user", "assistant"]
)
assert.equal(acpConversation.messages[1]?.provider, "cursor")
assert.equal(
  threadToMessages(
    [{ kind: "assistant", blocks: [{ type: "text", text: "Done" }] }],
    0,
    "devin"
  )[0]?.provider,
  "devin"
)
assert.deepEqual(
  acpConversation.messages[1]?.blocks.map((block) => block.type),
  ["thinking", "toolCall", "toolResult", "text"]
)
assert.equal(acpConversation.messages[1]?.streaming, true)
assert.deepEqual(acpConversation.plan, [
  { content: "Inspect", status: "completed" },
])
const canceledTool = acpBlocksToMessages(
  [
    {
      type: "tool",
      id: "tool-canceled",
      title: "Run command",
      toolKind: "exec_command",
      status: "canceled",
    },
  ],
  false
)
assert.equal(
  canceledTool.messages[0]?.blocks.find(
    (block) => block.type === "toolResult"
  )?.isCanceled,
  true
)

const acpEcho = {
  kind: "live",
  key: "acp-echo",
  draftKey: "draft-echo",
  harness: "grok",
  cwd: "/repo",
  blocks: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  session: {
    id: "acp-echo",
    harness: "grok",
    cwd: "/repo",
    status: "running",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
  permission: null,
  sending: false,
  canceling: false,
  queued: [],
} satisfies LiveAcpConversation
acpStore.set({
  activeKey: acpEcho.key,
  conversations: { [acpEcho.key]: acpEcho },
  bufferedUpdates: {},
  bufferedPermissions: {},
})
applyAcpUpdates("acp-echo", [
  { kind: "user", text: "same prompt" },
  { kind: "user", text: "same prompt" },
])
assert.deepEqual(acpStore.get().conversations[acpEcho.key]?.blocks, [
  { type: "user", text: "same prompt" },
])
acpStore.set({
  conversations: {
    [acpEcho.key]: {
      ...acpStore.get().conversations[acpEcho.key]!,
      blocks: [{ type: "user", text: "Visible question" }],
      hiddenUserPrompt: "Read the generated transcript, then answer.",
    },
  },
})
applyAcpUpdates("acp-echo", [
  { kind: "user", text: "Read the generated transcript, then answer." },
  { kind: "text", text: "Ready" },
])
assert.deepEqual(acpStore.get().conversations[acpEcho.key]?.blocks, [
  { type: "user", text: "Visible question" },
  { type: "text", text: "Ready" },
])
assert.equal(
  acpStore.get().conversations[acpEcho.key]?.hiddenUserPrompt,
  null
)

const backgroundA = {
  ...acpEcho,
  key: "acp-background-a",
  draftKey: "draft-background-a",
  threadPath: "/background-a",
  blocks: [],
  session: {
    ...acpEcho.session,
    id: "acp-background-a",
    harness: "claude",
    status: "running",
  },
} satisfies LiveAcpConversation
const backgroundB = {
  ...acpEcho,
  key: "acp-background-b",
  draftKey: "draft-background-b",
  threadPath: "/background-b",
  blocks: [],
  session: {
    ...acpEcho.session,
    id: "acp-background-b",
    harness: "codex",
    status: "running",
  },
} satisfies LiveAcpConversation
threadsStore.set({ working: {}, attention: {} })
acpStore.set({
  activeKey: backgroundB.key,
  conversations: {
    [backgroundA.key]: backgroundA,
    [backgroundB.key]: backgroundB,
  },
  bufferedUpdates: {},
  bufferedPermissions: {},
})
const stableBackgroundB = acpStore.get().conversations[backgroundB.key]
const presenceBeforeToken = selectAcpPresence(acpStore.get())
applyAcpUpdates(backgroundA.key, [{ kind: "text", text: "Background token" }])
assert.deepEqual(acpStore.get().conversations[backgroundA.key]?.blocks, [
  { type: "text", text: "Background token" },
])
assert.equal(
  sameAcpPresence(presenceBeforeToken, selectAcpPresence(acpStore.get())),
  true,
  "token updates must not repaint the rail"
)
assert.equal(
  acpStore.get().conversations[backgroundB.key],
  stableBackgroundB,
  "a background token must not replace the active conversation object"
)
applyAcpPermission({
  id: "permission-a",
  sessionId: backgroundA.key,
  title: "Run tests",
  options: [{ optionId: "allow", name: "Allow" }],
})
assert.equal(
  acpStore.get().conversations[backgroundA.key]?.kind === "live"
    ? acpStore.get().conversations[backgroundA.key]?.permission?.id
    : undefined,
  "permission-a"
)
assert.equal(threadsStore.get().attention["/background-a"]?.kind, "needs-permission")
assert.equal(acpStore.get().activeKey, backgroundB.key)
assert.equal(acp.activateThread("/background-a"), true)
assert.equal(acpStore.get().activeKey, backgroundA.key)
assert.equal(threadsStore.get().attention["/background-a"]?.kind, "needs-permission")
acpStore.set({ activeKey: backgroundB.key })
const queuedA = acpStore.get().conversations[backgroundA.key]
if (!queuedA || queuedA.kind !== "live") throw new Error("missing background A")
acpStore.set({
  conversations: {
    ...acpStore.get().conversations,
    [backgroundA.key]: {
      ...queuedA,
      permission: null,
      queued: [{ text: "Keep me", attachments: [] }],
    },
  },
})
applyAcpSession({ ...backgroundA.session, status: "ready" })
await Promise.resolve()
await Promise.resolve()
const restoredA = acpStore.get().conversations[backgroundA.key]
assert.equal(
  restoredA?.kind === "live" ? restoredA.queued[0]?.text : undefined,
  "Keep me",
  "a failed background queue drain must restore the prompt"
)
if (restoredA?.kind === "live") {
  acpStore.set({
    conversations: {
      ...acpStore.get().conversations,
      [backgroundA.key]: {
        ...restoredA,
        session: { ...restoredA.session, status: "running" },
        queued: [],
      },
    },
  })
}
applyAcpSession({ ...backgroundA.session, status: "ready" })
assert.equal(threadsStore.get().attention["/background-a"]?.kind, "review")
assert.equal(acpStore.get().activeKey, backgroundB.key)
acpStore.set({
  activeKey: null,
  conversations: {},
  bufferedUpdates: {},
  bufferedPermissions: {},
})
threadsStore.set({ working: {}, attention: {} })
applyAcpPermission({
  id: "permission-before-promotion",
  sessionId: "acp-not-promoted",
  title: "Choose access",
  options: [],
})
assert.equal(
  acpStore.get().bufferedPermissions["acp-not-promoted"]?.id,
  "permission-before-promotion"
)
acpStore.set({ bufferedPermissions: {} })

const interleavedResponse = [
  {
    id: "work-before",
    role: "assistant",
    blocks: [{ type: "toolCall", id: "one", name: "read" }],
  },
  {
    id: "commentary",
    role: "assistant",
    blocks: [
      { type: "toolCall", id: "two", name: "exec" },
      { type: "text", text: "The catalog is healthy." },
    ],
  },
  {
    id: "work-after",
    role: "assistant",
    blocks: [{ type: "toolCall", id: "three", name: "read" }],
  },
] satisfies ChatMessage[]
const interleavedSections = responseSections(interleavedResponse)
assert.deepEqual(
  interleavedSections.map((section) => section.kind),
  ["work", "prose", "work"]
)
assert.equal(
  interleavedSections[0]?.kind === "work"
    ? interleavedSections[0].messages.length
    : 0,
  2
)
assert.equal(
  interleavedSections[1]?.kind === "prose"
    ? interleavedSections[1].message.blocks[0]?.text
    : undefined,
  "The catalog is healthy."
)
assert.equal(
  interleavedSections[2]?.kind === "work"
    ? interleavedSections[2].messages.length
    : 0,
  1
)
const waitingEntries: ThreadEntry[] = [
  {
    kind: "assistant",
    blocks: [
      {
        type: "tool",
        name: "ask_user_question",
        input: '{"question":"Continue?"}',
      },
    ],
  },
]
assert.equal(pendingThreadInput(waitingEntries), "ask_user_question")
assert.equal(
  pendingThreadInput([
    {
      kind: "assistant",
      blocks: [
        {
          type: "tool",
          name: "ask_user_question",
          input: '{"question":"Continue?"}',
          output: "Continue",
        },
      ],
    },
  ]),
  null
)

const usageThread: Thread = {
  ref: {
    harness: "claude",
    nativeId: "usage",
    path: "/usage",
    model: "claude-opus",
  },
  entries: [
    {
      kind: "assistant",
      model: "claude-opus",
      usage: { input: 100, output: 20, cacheRead: 50, costUsd: 0.5 },
      blocks: [],
    },
    {
      kind: "assistant",
      model: "claude-opus",
      usage: { input: 180, output: 30, costUsd: 0.75 },
      blocks: [],
    },
  ],
}
const usageProfiles = {
  claude: {
    id: "claude",
    label: "Claude Code",
    available: true,
    transport: "acp",
    models: [
      {
        id: "claude-opus",
        label: "Claude Opus",
        contextWindow: 200_000,
        options: [],
      },
    ],
    capabilities: [],
  },
} satisfies Record<string, HarnessProfile>
assert.deepEqual(
  contextAccounting({
    viewing: usageThread,
    acpSession: null,
    acpStarting: false,
    composerHarness: "claude",
    profiles: usageProfiles,
  }),
  {
    kind: "reported-input",
    owner: "thread",
    harness: "claude",
    model: "claude-opus",
    lastInput: 180,
    window: 200_000,
    cost: 1.25,
    stats: {
      input: 280,
      output: 50,
      cacheRead: 50,
      cacheWrite: 0,
      total: 380,
    },
  }
)
assert.equal(
  contextAccounting({
    viewing: usageThread,
    acpSession: null,
    acpStarting: true,
    composerHarness: "claude",
    profiles: usageProfiles,
  }).kind,
  "unavailable"
)

const folderRefs = [
  {
    harness: "opencode",
    nativeId: "one",
    path: "/one",
    cwd: "/repo/packages/app",
    workspace: "/repo",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    harness: "codex",
    nativeId: "two",
    path: "/two",
    cwd: "/repo",
    workspace: "/repo",
    updatedAt: "2026-01-03T00:00:00.000Z",
  },
] satisfies ThreadRef[]
assert.equal(threadFolderKey(folderRefs[0]), "/repo")
assert.equal(
  threadFolderKey({
    harness: "claude",
    nativeId: "temp",
    path: "/temp",
    cwd: "/private/tmp/session",
  }),
  ""
)
const homeRef = {
  harness: "claude",
  nativeId: "home",
  path: "/home",
  cwd: "/Users/kashyab",
} satisfies ThreadRef
assert.equal(threadFolderKey(homeRef), "/Users/kashyab")
assert.equal(
  threadBelongsToWorkspace(
    { ...homeRef, cwd: "/Users/kashyab/repos/nu/arca" },
    "/Users/kashyab"
  ),
  true
)
assert.equal(
  threadBelongsToWorkspace(
    { ...homeRef, cwd: "/Users/kashyab-other/repo" },
    "/Users/kashyab"
  ),
  false
)
assert.deepEqual(
  groupThreadFolders({
    refs: [],
    currentCwd: "/Users/kashyab",
    pinnedThreads: [],
    pinnedFolders: [],
    sortBy: "recent",
  }).map((folder) => ({
    cwd: folder.cwd,
    name: folder.name,
    count: folder.refs.length,
    current: folder.current,
  })),
  [{ cwd: "/Users/kashyab", name: "Home", count: 0, current: true }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: folderRefs,
    currentCwd: "/repo/packages/app",
    pinnedThreads: [],
    pinnedFolders: [],
    sortBy: "recent",
  }).map((folder) => ({ cwd: folder.cwd, count: folder.refs.length })),
  [{ cwd: "/repo", count: 2 }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: [folderRefs[1]!],
    currentCwd: "/repo/packages/unknown",
    pinnedThreads: [],
    pinnedFolders: ["/repo/"],
    sortBy: "recent",
  }).map((folder) => ({ cwd: folder.cwd, current: folder.current, pinned: folder.pinned })),
  [{ cwd: "/repo", current: true, pinned: true }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: folderRefs,
    currentCwd: "/repo",
    pinnedThreads: [],
    pinnedFolders: [],
    priorities: { "/one": 5 },
    sortBy: "recent",
  })[0]?.refs.map((ref) => ref.path),
  ["/one", "/two"]
)
const activeFolders = groupThreadFolders({
  refs: [
    { ...folderRefs[0]!, path: "/quiet", cwd: "/quiet", workspace: "/quiet", updatedAt: "2026-08-30T12:00:00Z" },
    { ...folderRefs[1]!, path: "/live", cwd: "/live", workspace: "/live", updatedAt: "2026-08-29T12:00:00Z" },
  ],
  pinnedThreads: [],
  pinnedFolders: [],
  priorities: { "/live": 2 },
  activity: { "/live": { running: true } },
  sortBy: "recent",
})
assert.equal(activeFolders[0]?.cwd, "/live")
assert.equal(activeFolders[0]?.running, 1)
assert.equal(activeFolders[0]?.priority, 2)
assert.ok(
  threadStatusPriority({ kind: "needs-permission", since: 1 }) >
    threadStatusPriority({ kind: "working", since: 1 })
)

const statusState = threadsStore.get()
const openCodeRef = {
  harness: "opencode" as const,
  nativeId: "session",
  path: "/session",
}
assert.deepEqual(threadStatus({ ...openCodeRef, active: true }, statusState), {
  kind: "external-active",
})
assert.deepEqual(
  threadStatus(
    { ...openCodeRef, active: false },
    { ...statusState, observed: { "/session": true } }
  ),
  { kind: "idle" }
)
const liveCodexRefs = [
  {
    harness: "codex",
    nativeId: "codex-one",
    path: "/codex-one",
    cwd: "/other-project",
    updatedAt: "2026-08-30T13:05:00Z",
  },
  {
    harness: "codex",
    nativeId: "codex-two",
    path: "/codex-two",
    cwd: "/other-project",
    updatedAt: "2026-08-30T13:05:01Z",
  },
] satisfies ThreadRef[]
const activityNow = Date.parse("2026-08-30T13:05:30Z")
assert.equal(
  recentThreadActivityDuration(liveCodexRefs[0]!, activityNow),
  30_000
)
assert.equal(
  recentThreadActivityDuration(
    { ...liveCodexRefs[0]!, active: false },
    activityNow
  ),
  null
)
assert.deepEqual(
  activeThreadRefs(liveCodexRefs, {
    ...statusState,
    observed: { "/codex-one": true, "/codex-two": true },
  }).map((ref) => ref.nativeId),
  ["codex-two", "codex-one"]
)

const backgroundRef = {
  harness: "grok",
  nativeId: "background",
  path: "/background",
} satisfies ThreadRef
threadsStore.set({
  viewing: { ref: openCodeRef, entries: [] },
  attention: {},
  working: {},
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "running",
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "done",
})
const backgroundAttention = threadsStore.get().attention[backgroundRef.path]
assert.equal(backgroundAttention?.kind, "review")
assert.equal(
  backgroundAttention?.kind === "review" && backgroundAttention.unread,
  true
)
markThreadReviewed(backgroundRef.path)
assert.equal(threadsStore.get().attention[backgroundRef.path], undefined)
threadsStore.set({
  viewing: { ref: backgroundRef, entries: [] },
  attention: {},
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "done",
})
assert.equal(threadsStore.get().attention[backgroundRef.path], undefined)

const queuedRef = {
  harness: "codex",
  nativeId: "queued",
  path: "/queued",
} satisfies ThreadRef
threadsStore.set({ viewing: { ref: queuedRef, entries: [] } })
assert.equal(appendOptimisticReply(queuedRef, "move now"), true)
assert.equal(threadsStore.get().viewing?.entries.length, 1)
removeOptimisticReply(queuedRef, "move now")
assert.equal(threadsStore.get().viewing?.entries.length, 0)

let queuedSend: { ref: ThreadRef; prompt: string } | null = null
bindQueuedReplySender(async (ref, prompt) => {
  queuedSend = { ref, prompt }
  return true
})
threadsStore.set({
  queuedReplies: {
    [queuedRef.path]: { ref: queuedRef, prompts: ["second turn"] },
  },
})
releaseQueuedReply(queuedRef.path)
await new Promise((resolve) => setTimeout(resolve, 80))
assert.deepEqual(queuedSend, { ref: queuedRef, prompt: "second turn" })
assert.equal(threadsStore.get().queuedReplies[queuedRef.path], undefined)

console.log("stage layout, tool mapping, subagent formatting, and explicit activity passed")
