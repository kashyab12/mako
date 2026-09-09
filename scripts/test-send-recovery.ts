import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const worker = process.argv[2] === "--reload"
const directory = worker
  ? process.argv[3]
  : mkdtempSync(join(tmpdir(), "mako-send-recovery-"))
assert.ok(directory)
const storage = join(directory, "pending.json")
Object.assign(globalThis, {
  localStorage: {
    getItem: () => {
      try {
        return readFileSync(storage, "utf8")
      } catch {
        return null
      }
    },
    setItem: (_key: string, value: string) => writeFileSync(storage, value),
  },
})
const recovery = await import("../src/state/send-recovery.ts")
if (worker) {
  const interrupted = recovery.sendRecoveryStore.get().interrupted
  assert.equal(interrupted.length, Number(process.argv[4]))
  assert.equal(
    recovery.sendRecoveryStore.get().pending.size,
    0,
    "Reload never schedules a repeated send"
  )
  if (interrupted.length) {
    assert.equal(interrupted[0]?.text, "Keep this paragraph")
    assert.equal(interrupted[0]?.attachments[0]?.stagedPath, "/staged/file.png")
    assert.equal(interrupted[0]?.attachments[0]?.preview, undefined)
  }
} else {
  function reload(count: number) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        "--reload",
        directory,
        String(count),
      ],
      { encoding: "utf8" }
    )
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    const id = recovery.preserveSendingDraft({
      key: "source-conversation",
      text: "Keep this paragraph",
      attachments: [
        {
          id: "file",
          index: 1,
          name: "file.png",
          mimeType: "image/png",
          size: 123,
          kind: "image",
          stagedPath: "/staged/file.png",
          preview: "blob:expired",
        },
      ],
    })
    assert.ok(id)
    assert.equal(
      recovery.sendRecoveryStore.get().interrupted.length,
      0,
      "Active sends do not show a recovery warning"
    )
    reload(1)
    recovery.settleSendingDraft(id)
    reload(0)
    const unexpected = recovery.preserveSendingDraft({
      key: "other",
      text: "Keep this paragraph",
      attachments: [],
    })
    assert.ok(unexpected)
    recovery.interruptSendingDraft(unexpected)
    assert.equal(recovery.sendRecoveryStore.get().pending.size, 0)
    assert.equal(
      recovery.sendRecoveryStore.get().interrupted[0]?.id,
      unexpected
    )
    recovery.takeInterruptedSend(unexpected)
    reload(0)
    Object.assign(globalThis, {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota")
        },
      },
    })
    assert.equal(
      recovery.preserveSendingDraft({
        key: "full-storage",
        text: "Still in composer",
        attachments: [],
      }),
      null,
      "A send must not clear the composer if its recovery copy cannot be saved"
    )
    console.log(
      "Send recovery survives a fresh renderer process, retains staged files, never replays automatically, and clears settled receipts"
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
