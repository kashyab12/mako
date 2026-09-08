import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// Run against a live development desk. The gateway fixture must not invalidate
// dependencies already advertised to that desk's renderer.
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5174/")
assert.equal(origin.hostname, "127.0.0.1")
const moduleResponse = await fetch(
  new URL("/src/components/inspector/terminal-panel.tsx", origin)
)
assert.equal(moduleResponse.status, 200)
const source = await moduleResponse.text()
const dependencies = [
  ...source.matchAll(/from "([^"]*xterm[^"\n]*\.js\?[^"\n]+)"/g),
].map((match) => new URL(match[1], origin))
assert.equal(
  dependencies.length,
  4,
  "All four optimized terminal dependencies must be observed in the live module"
)
async function verifyDependencies(phase) {
  for (const dependency of dependencies) {
    const response = await fetch(dependency)
    assert.equal(
      response.status,
      200,
      `${phase}: ${dependency.pathname} must remain available`
    )
    assert.ok((await response.text()).length > 100)
  }
}
await verifyDependencies("before the web regression server")
await promisify(execFile)(process.execPath, ["scripts/test-web-proxy.mjs"], {
  timeout: 30_000,
})
await verifyDependencies("after the web regression server")
console.log(
  "Web cache isolation: all four live terminal dependencies remain HTTP 200 after the independent gateway test starts and stops"
)
