import assert from "node:assert/strict"
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
  toolLabel,
} from "../src/lib/tools.ts"
import { threadStatus, threadsStore } from "../src/state/threads.ts"
import {
  appendOptimisticReply,
  bindQueuedReplySender,
  releaseQueuedReply,
  removeOptimisticReply,
} from "../src/state/thread-queue.ts"
import {
  groupThreadFolders,
  threadFolderKey,
} from "../src/lib/thread-folders.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import { contextAccounting } from "../src/lib/context-accounting.ts"
import { responseSections } from "../src/lib/exchanges.ts"
import {
  pendingThreadInput,
  threadToMessages,
} from "../src/lib/foreign-thread.ts"
import { acpStore, applyAcpUpdates } from "../src/state/acp.ts"
import type {
  ChatMessage,
  HarnessProfile,
  Thread,
  ThreadEntry,
  ThreadRef,
} from "../src/lib/types.ts"

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

acpStore.set({
  session: {
    id: "acp-echo",
    harness: "grok",
    cwd: "/repo",
    status: "running",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
  blocks: [],
  permission: null,
  starting: false,
  queued: null,
  hiddenUserPrompt: null,
})
applyAcpUpdates("acp-echo", [
  { kind: "user", text: "same prompt" },
  { kind: "user", text: "same prompt" },
])
assert.deepEqual(acpStore.get().blocks, [
  { type: "user", text: "same prompt" },
])
acpStore.set({
  blocks: [{ type: "user", text: "Visible question" }],
  hiddenUserPrompt: "Read the generated transcript, then answer.",
})
applyAcpUpdates("acp-echo", [
  { kind: "user", text: "Read the generated transcript, then answer." },
  { kind: "text", text: "Ready" },
])
assert.deepEqual(acpStore.get().blocks, [
  { type: "user", text: "Visible question" },
  { type: "text", text: "Ready" },
])
assert.equal(acpStore.get().hiddenUserPrompt, null)
acpStore.set({ session: null, blocks: [], hiddenUserPrompt: null })

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
