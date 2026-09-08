import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeKeychain, deleteKeychain } from "../electron/accounts-common.js"

if (process.platform === "darwin") {
  const root = await mkdtemp(join(tmpdir(), "mako-keychain-test-"))
  const originalPath = process.env.PATH
  try {
    const security = join(root, "security")
    await writeFile(security, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    process.env.PATH = `${root}:${originalPath ?? ""}`
    await assert.rejects(
      writeKeychain("mako-fixture", "credential-must-not-appear"),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Could not save/)
        assert.doesNotMatch(error.message, /credential-must-not-appear/)
        return true
      }
    )
    await assert.rejects(deleteKeychain("mako-fixture"), /Could not remove/)
    await writeFile(security, "#!/bin/sh\nexit 44\n", { mode: 0o700 })
    await deleteKeychain("mako-fixture")
    await writeFile(security, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await writeKeychain("mako-fixture", "fixture")
    await deleteKeychain("mako-fixture")
    console.log(
      "Account Keychain: write failures are visible and redacted, delete failures are visible, and absent entries are idempotent"
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
}
