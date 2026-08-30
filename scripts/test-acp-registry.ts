import assert from "node:assert/strict"
import type { AcpSessionState } from "../src/lib/types.ts"

interface StartRequest {
  harness: string
  cwd: string
  result: PromiseWithResolvers<AcpSessionState>
}

const starts: StartRequest[] = []
const prompts: Array<{ id: string; text: string }> = []
const closed: string[] = []
let applySession: ((session: AcpSessionState) => void) | undefined

Object.assign(globalThis, {
  window: {
    mako: {
      acpStart: (harness: string, cwd: string) => {
        const result = Promise.withResolvers<AcpSessionState>()
        starts.push({ harness, cwd, result })
        return result.promise
      },
      acpPrompt: async (id: string, text: string) => {
        prompts.push({ id, text })
        const session = sessions.get(id)
        if (!session) throw new Error("missing fake session")
        const running = { ...session, status: "running" as const }
        sessions.set(id, running)
        applySession?.(running)
      },
      acpClose: async (id: string) => {
        closed.push(id)
        sessions.delete(id)
      },
      acpCancel: async () => {},
      acpPermission: async () => {},
      acpSetMode: async () => {},
    },
  },
})

const {
  acp,
  acpStore,
  activeLiveAcp,
  applyAcpPermission,
  applyAcpSession,
  applyAcpUpdates,
} = await import("../src/state/acp.ts")
applySession = applyAcpSession
const sessions = new Map<string, AcpSessionState>()

const state = (
  id: string,
  harness: string,
  cwd: string,
  status: AcpSessionState["status"] = "ready"
): AcpSessionState => ({
  id,
  nativeId: `native-${id}`,
  harness,
  cwd,
  status,
  modes: [],
  currentMode: null,
  configOptions: [],
})

const startA = acp.startFresh("claude", "/a", "first A", [], "first A", "/a")
const startB = acp.startFresh("codex", "/b", "first B", [], "first B", "/b")
assert.equal(starts.length, 2)
assert.equal(Object.keys(acpStore.get().conversations).length, 2)
assert.equal(acpStore.get().conversations[acpStore.get().activeKey ?? ""]?.harness, "codex")

applyAcpPermission({
  id: "permission-before-ready",
  sessionId: "acp-a",
  title: "Read a file",
  options: [{ optionId: "allow", name: "Allow" }],
})
const sessionA = state("acp-a", "claude", "/a")
const sessionB = state("acp-b", "codex", "/b")
sessions.set(sessionA.id, sessionA)
sessions.set(sessionB.id, sessionB)
starts[0]?.result.resolve(sessionA)
starts[1]?.result.resolve(sessionB)
assert.equal(await startA, true)
assert.equal(await startB, true)
assert.deepEqual(prompts, [
  { id: "acp-a", text: "first A" },
  { id: "acp-b", text: "first B" },
])
assert.equal(Object.keys(acpStore.get().conversations).length, 2)
assert.equal(
  acpStore.get().conversations["acp-a"]?.kind === "live"
    ? acpStore.get().conversations["acp-a"]?.permission?.id
    : undefined,
  "permission-before-ready"
)

acp.activate("acp-b")
const stableB = acpStore.get().conversations["acp-b"]
applyAcpUpdates("acp-a", [{ kind: "text", text: "background A" }])
assert.equal(acpStore.get().conversations["acp-b"], stableB)
assert.deepEqual(acpStore.get().conversations["acp-a"]?.blocks, [
  { type: "user", text: "first A" },
  { type: "text", text: "background A" },
])

assert.equal(await acp.send("queued B"), true)
const queuedB = activeLiveAcp(acpStore.get())
assert.equal(queuedB?.queued[0]?.text, "queued B")
applyAcpSession({ ...sessionB, status: "ready", lastStop: "end_turn" })
await Promise.resolve()
assert.deepEqual(prompts.at(-1), { id: "acp-b", text: "queued B" })
assert.equal(activeLiveAcp(acpStore.get())?.queued.length, 0)
assert.equal(
  acpStore.get().conversations["acp-a"]?.kind === "live"
    ? acpStore.get().conversations["acp-a"]?.permission?.id
    : undefined,
  "permission-before-ready"
)

acp.activate("acp-a")
assert.equal(acp.close(), true)
assert.deepEqual(closed, ["acp-a"])
assert.equal(acpStore.get().conversations["acp-a"], undefined)
assert.equal(acpStore.get().conversations["acp-b"]?.kind, "live")

const failedStart = acp.startFresh("grok", "/c", "first C", [], "first C", "/c")
const queuedDuringStart = acp.send("second C")
starts.at(-1)?.result.reject(new Error("start rejected"))
assert.equal(await failedStart, false)
assert.equal(await queuedDuringStart, false)
assert.equal(
  Object.values(acpStore.get().conversations).some(
    (conversation) => conversation.threadPath === "/c"
  ),
  false
)

console.log("concurrent ACP registry isolation, queueing, permissions, and cleanup passed")
