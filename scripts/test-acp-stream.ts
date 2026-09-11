import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { acpReadable, acpWritable } from "../electron/acp-stream.ts"

// A provider that closed its stdin but is still running: a write fails with
// EPIPE, which Node reports through the callback and as a pipe `error` event.
const child = spawn("sh", ["-c", "exec 0<&-; sleep 2"], {
  stdio: ["pipe", "pipe", "pipe"],
})
const uncaught: Error[] = []
const observe = (error: Error) => uncaught.push(error)
process.on("uncaughtException", observe)
try {
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  const writer = acpWritable(child.stdin).getWriter()
  await assert.rejects(
    writer.write(new Uint8Array(70_000).fill(120)),
    (error: NodeJS.ErrnoException) => error.code === "EPIPE"
  )
  await assert.rejects(writer.write(new Uint8Array([10])))
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(uncaught, [], "A closed provider stdin must not crash the host")
} finally {
  process.off("uncaughtException", observe)
  child.kill()
}

const echo = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] })
const reader = acpReadable(echo.stdout).getReader()
const writer = acpWritable(echo.stdin).getWriter()
await writer.write(new TextEncoder().encode("ping\n"))
const first = await reader.read()
assert.equal(new TextDecoder().decode(first.value), "ping\n")
await writer.close()
const rest: string[] = []
for (let next = await reader.read(); !next.done; next = await reader.read())
  rest.push(new TextDecoder().decode(next.value))
assert.deepEqual(rest, [])
console.log(
  "ACP streams: a closed provider stdin rejects the pending write and errors the stream without an uncaught exception; open pipes round-trip and close cleanly"
)
