import { providerHost } from "../electron/providers/index.ts"
import { syncThreadStatus } from "../src/state/acp-live.ts"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  clampCompanionWidth,
  clampDockHeight,
  fitsBeside,
} from "../src/components/stage/stage-width.ts"
import {
  decodeFileCitation,
  linkFileCitations,
  markdownFileTarget,
} from "../src/lib/file-citations.ts"
import {
  argAt,
  isSubagentLaunch,
  normalizeToolOutput,
  parseToolExecutionOutput,
  subagentResultId,
  subagentResultText,
  summarizeToolWork,
  toolLabel,
} from "../src/lib/tools.ts"
import {
  activeThreadRefs,
  applyThreadActivity,
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
import { acp, acpStore, type LiveAcpConversation } from "../src/state/acp.ts"
import { applyLiveBatch } from "../src/state/live-recovery.ts"
import type {
  LiveUpdate,
  LivePermissionRequest,
  LiveSessionState,
} from "../src/lib/types.ts"
function applySession(session: LiveSessionState) {
  applyLiveBatch({
    id: session.id,
    revision: (acpStore.get().conversations[session.id]?.revision ?? 0) + 1,
    updates: [],
    session,
  })
}
function applyUpdates(id: string, updates: LiveUpdate[]) {
  applyLiveBatch({
    id,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    updates,
  })
}
function applyPermission(request: LivePermissionRequest) {
  applyLiveBatch({
    id: request.sessionId,
    revision:
      (acpStore.get().conversations[request.sessionId]?.revision ?? 0) + 1,
    updates: [],
    permissions: [request],
  })
}
import {
  canonicalThreadRefs,
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
const threadViewerSource = readFileSync(
  new URL("../src/components/viewer/thread-viewer.tsx", import.meta.url),
  "utf8"
)
const threadViewingSource = readFileSync(
  new URL("../src/state/thread-viewing.ts", import.meta.url),
  "utf8"
)
// Decorative motion is allowed only on the ocean layers, paused until the
// visible scene opts in. Transcript and workspace chrome must never loop.
const motionLayers = new Set([
  ".ocean-light",
  ".ocean-grain",
  ".ocean-fin-glint",
])
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
const rules = [...cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
for (const [, selector, declarations] of rules) {
  if (
    !/\banimation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(declarations!)
  )
    continue
  assert.ok(
    motionLayers.has(selector!.trim()),
    `Unexpected looping animation: ${selector!.trim()}`
  )
  assert.match(declarations!, /animation-play-state:\s*paused\s*;/)
}
const reducedMotion = [
  ...cssWithoutComments.matchAll(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g
  ),
]
for (const layer of motionLayers) {
  assert.ok(
    rules.some(
      ([, selectors, declarations]) =>
        selectors!
          .split(",")
          .map((value) => value.trim())
          .includes(`.ocean-scene[data-water-moving] ${layer}`) &&
        /animation-play-state:\s*running\s*;/.test(declarations!)
    ),
    `${layer} runs only through the scene's motion gate`
  )
  assert.ok(
    rules.some(
      ([, selectors, declarations]) =>
        selectors!.includes(
          `.agent-surface:has(.composer-input:focus) ${layer}`
        ) && /animation-play-state:\s*paused\s*;/.test(declarations!)
    ),
    `${layer} pauses while composing`
  )
  assert.ok(
    reducedMotion.some(
      ([, body]) => body!.includes(layer) && /animation:\s*none\s*;/.test(body!)
    ),
    `${layer} respects reduced motion`
  )
}
const oceanSource = readFileSync(
  new URL("../src/components/ui/ocean-scene.tsx", import.meta.url),
  "utf8"
)
assert.match(
  oceanSource,
  /motion && visible && !document\.hidden && !media\.matches/
)
assert.match(threadViewerSource, /Loading messages…/)
assert.match(threadViewerSource, /Syncing messages…/)
assert.doesNotMatch(threadViewerSource, /Opening \{opening/)
assert.match(threadViewingSource, /Showing saved messages/)
assert.equal(composerActionKind({ running: false, hasContent: false }), "send")
assert.equal(composerActionKind({ running: false, hasContent: true }), "send")
assert.equal(composerActionKind({ running: true, hasContent: false }), "stop")
assert.equal(composerActionKind({ running: true, hasContent: true }), "queue")
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
assert.equal(
  runningTerminalForWorkspace(restoredTerminals, "/repo/a"),
  undefined
)
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
assert.equal(clampCompanionWidth({ width: 520, available: 800, min: 400 }), 400)
assert.equal(fitsBeside(851, 400), true)
assert.equal(fitsBeside(850, 400), false)
assert.equal(clampDockHeight({ height: 280, available: 900, min: 180 }), 280)
assert.equal(clampDockHeight({ height: 600, available: 500, min: 180 }), 240)
assert.equal(clampDockHeight({ height: 120, available: 300, min: 180 }), 180)
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
assert.equal(
  argAt('{"description":"Read package name"}', "description"),
  "Read package name"
)
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
assert.equal(toolLabel("WAIT"), "Wait for command")
assert.equal(
  isSubagentLaunch({
    id: "wait",
    name: "wait",
    arguments: { cell_id: "706" },
    pending: false,
  }),
  false
)
assert.equal(
  normalizeToolOutput(
    JSON.stringify([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.0 seconds\nOutput:\n",
      },
      { type: "input_text", text: "step_name status\nassemble running" },
    ])
  ),
  "Script completed\nWall time 0.0 seconds\nOutput:\n\nstep_name status\nassemble running"
)
assert.equal(
  normalizeToolOutput(
    JSON.stringify({
      chunk_id: "chunk",
      wall_time_seconds: 1,
      session_id: 7,
      output: "final output",
    })
  ),
  "final output"
)
assert.deepEqual(
  parseToolExecutionOutput(
    "Script completed\nWall time 0.0 seconds\nOutput:\nrows: 390"
  ),
  {
    status: "Script completed",
    duration: "0.0 seconds",
    output: "rows: 390",
  }
)
const linkedCitation = linkFileCitations(
  'Final cleaned CSV: :codex-file-citation{path="/work/output.csv" purpose="output"}'
)
const citationHref = /\((mako-citation:[^)]+)\)/.exec(linkedCitation)?.[1]
assert.deepEqual(decodeFileCitation(citationHref), {
  path: "/work/output.csv",
  purpose: "output",
})
assert.deepEqual(markdownFileTarget("/work/src/index.ts#L12-L18"), {
  path: "/work/src/index.ts",
  line: 12,
  endLine: 18,
})
assert.deepEqual(
  summarizeToolWork([
    {
      id: "edit-a",
      name: "edit",
      arguments: { file_path: "src/a.ts" },
      pending: false,
    },
    {
      id: "edit-a-2",
      name: "write",
      arguments: { path: "src/a.ts" },
      pending: false,
    },
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
assert.equal(
  threadToMessages([
    {
      kind: "assistant",
      blocks: [{ type: "tool", name: "shell", canceled: true }],
    },
  ])[0]?.blocks.find((block) => block.type === "toolResult")?.isCanceled,
  true
)
assert.deepEqual(
  acpConversation.messages[1]?.blocks.map((block) => block.type),
  ["thinking", "toolCall", "toolResult", "text", "toolResult"]
)
assert.deepEqual(acpConversation.messages[1]?.blocks.at(-1), {
  type: "toolResult",
  id: "plan-4",
  name: "Plan",
  text: "",
  details: [
    { type: "plan", entries: [{ content: "Inspect", status: "completed" }] },
  ],
})
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
  canceledTool.messages[0]?.blocks.find((block) => block.type === "toolResult")
    ?.isCanceled,
  true
)

const acpEcho = {
  kind: "live",
  key: "acp-echo",
  hydrated: true,
  revision: 0,
  draftKey: "draft-echo",
  harness: "grok",
  cwd: "/repo",
  blocks: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  session: {
    id: "acp-echo",
    connection: "connected",
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
})
applyUpdates("acp-echo", [
  { kind: "user", text: "same prompt" },
  { kind: "user", text: "same prompt" },
])
assert.deepEqual(acpStore.get().conversations[acpEcho.key]?.blocks, [
  {
    type: "user",
    text: "same prompt",
    attachments: undefined,
    provider: undefined,
    requestId: undefined,
    contextFiles: undefined,
  },
  {
    type: "user",
    text: "same prompt",
    attachments: undefined,
    provider: undefined,
    requestId: undefined,
    contextFiles: undefined,
  },
])
const backgroundA = {
  ...acpEcho,
  key: "acp-background-a",
  harness: "claude",
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
  harness: "codex",
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
})
const stableBackgroundB = acpStore.get().conversations[backgroundB.key]
const presenceBeforeToken = selectAcpPresence(acpStore.get())
applyUpdates(backgroundA.key, [{ kind: "text", text: "Background token" }])
assert.deepEqual(acpStore.get().conversations[backgroundA.key]?.blocks, [
  { type: "text", text: "Background token", id: undefined },
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
applyPermission({
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
assert.equal(
  threadsStore.get().attention["/background-a"]?.kind,
  "needs-permission"
)
assert.equal(acpStore.get().activeKey, backgroundB.key)
assert.equal(acp.activateThread("/background-a"), true)
assert.equal(acpStore.get().activeKey, backgroundA.key)
assert.equal(
  threadsStore.get().attention["/background-a"]?.kind,
  "needs-permission"
)
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
applySession({ ...backgroundA.session, status: "ready" })
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
applySession({ ...backgroundA.session, status: "ready" })
assert.equal(threadsStore.get().attention["/background-a"]?.kind, "review")
assert.equal(acpStore.get().activeKey, backgroundB.key)
acpStore.set({
  activeKey: null,
  conversations: {},
})
threadsStore.set({ working: {}, attention: {} })
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
  }).map((folder) => ({
    cwd: folder.cwd,
    current: folder.current,
    pinned: folder.pinned,
  })),
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
    {
      ...folderRefs[0]!,
      path: "/quiet",
      cwd: "/quiet",
      workspace: "/quiet",
      updatedAt: "2026-08-30T12:00:00Z",
    },
    {
      ...folderRefs[1]!,
      path: "/live",
      cwd: "/live",
      workspace: "/live",
      updatedAt: "2026-08-29T12:00:00Z",
    },
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
  []
)
threadsStore.set({
  threads: liveCodexRefs,
  externalActivity: {},
  observed: {},
  working: {},
  attention: {},
})
applyThreadActivity("/codex-one", {
  provider: "codex",
  since: 10,
  status: "needs-input",
  detail: "permission prompt",
})
assert.deepEqual(
  threadsStore.get().threads.map((ref) => ref.nativeId),
  ["codex-one", "codex-two"]
)
assert.deepEqual(threadStatus(liveCodexRefs[0]!, threadsStore.get()), {
  kind: "needs-permission",
  since: 10,
  detail: "permission prompt",
})
applyThreadActivity("/codex-one", null)

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

console.log(
  "stage layout, tool mapping, subagent formatting, and explicit activity passed"
)

const aliases = [
  { path: "/source" },
  { path: "/destination" },
  { path: "/unrelated" },
]
const canonicalPresence = [
  {
    ...presenceBeforeToken[0]!,
    threadPath: "/destination",
    nativePaths: ["/source", "/destination"],
  },
]
assert.deepEqual(canonicalThreadRefs(aliases, canonicalPresence, []), [
  aliases[1],
  aliases[2],
])
assert.deepEqual(
  canonicalThreadRefs(aliases, canonicalPresence, ["/source"]),
  [aliases[0], aliases[2]],
  "a pinned native alias remains the canonical row"
)
assert.equal(
  sameAcpPresence(
    canonicalPresence,
    canonicalPresence.map((presence) => ({
      ...presence,
      nativePaths: [...presence.nativePaths],
    }))
  ),
  true
)

// Every registered provider must obey the same renderer lifecycle rules.
for (const { provider: harness } of providerHost.liveDrivers.list()) {
  const path = `/activity/${harness}`
  const ref: ThreadRef = { harness, nativeId: harness, path }
  threadsStore.set({
    working: {},
    attention: {},
    externalActivity: {},
    observed: { [path]: true },
  })
  assert.deepEqual(
    activeThreadRefs([{ ...ref, locked: true }]),
    [],
    `${harness}: open + recently changed does not mean running`
  )
  const conversation: LiveAcpConversation = {
    ...acpEcho,
    key: harness,
    harness,
    threadPath: path,
    session: { ...acpEcho.session, id: harness, harness, status: "running" },
  }
  syncThreadStatus(conversation, "ready")
  assert.equal(
    activeThreadRefs([ref]).length,
    1,
    `${harness}: real turn start is running`
  )
  syncThreadStatus(
    { ...conversation, session: { ...conversation.session, status: "ready" } },
    "running"
  )
  assert.equal(
    activeThreadRefs([ref]).length,
    0,
    `${harness}: turn completion clears running`
  )
  threadsStore.set({
    attention: { [path]: { kind: "needs-permission", since: 1 } },
  })
  syncThreadStatus(
    { ...conversation, session: { ...conversation.session, status: "closed" } },
    "running"
  )
  assert.equal(
    activeThreadRefs([ref]).length,
    0,
    `${harness}: closure clears stale permission state`
  )
  threadsStore.set({
    attention: { [path]: { kind: "review", at: 1, unread: true } },
    externalActivity: {
      [path]: { provider: harness, status: "active", since: 2 },
    },
  })
  assert.equal(
    threadStatus(ref).kind,
    "external-active",
    `${harness}: a new external run supersedes an old completion badge`
  )
  threadsStore.set({
    externalActivity: {},
    working: {},
    attention: {},
    observed: {},
  })
}
console.log(
  "Every registered harness: open/recent, running, completed, closed while waiting, and restarted externally verified"
)
