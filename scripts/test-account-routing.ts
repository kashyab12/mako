import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import {
  accountDir,
  accountsRoot,
  readSelection,
  writeSelection,
} from "../electron/accounts-common.js"
import { codexAccountCapability } from "../electron/providers/codex/accounts.js"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.js"

const sandbox = await mkdtemp(join(os.tmpdir(), "mako-account-routing-"))
mock.method(os, "homedir", () => sandbox)
syncBuiltinESMExports()
try {
  for (const capability of [codexAccountCapability, claudeAccountCapability]) {
    const base = {
      OPENAI_API_KEY: "fixture",
      ANTHROPIC_API_KEY: "fixture",
      PATH: "/fixture",
    }
    assert.deepEqual(await capability.accountEnv(null, base), base)
    await assert.rejects(
      capability.accountEnv("missing", base),
      /selected.*account/i
    )
    for (const invalid of ["../escape", "/absolute", "..", "a/b", "a\\b"])
      assert.throws(
        () => accountDir(capability.provider, invalid),
        /Invalid account name/
      )
    const directory = accountDir(capability.provider, "saved")
    await mkdir(directory, { recursive: true })
    const marker = join(directory, "existing-identity")
    await writeFile(marker, "preserve")
    await assert.rejects(capability.captureAccount("saved"), /EEXIST/)
    assert.equal(await readFile(marker, "utf8"), "preserve")
  }
  const codexDir = accountDir("codex", "ready")
  await mkdir(codexDir, { recursive: true })
  await writeFile(
    join(codexDir, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "fixture" })
  )
  const codexEnv = await codexAccountCapability.accountEnv("ready", {
    OPENAI_API_KEY: "other",
    CODEX_HOME: "/other",
  })
  assert.deepEqual(codexEnv, { CODEX_HOME: codexDir })
  await assert.rejects(
    codexAccountCapability.accountEnv("saved", {}),
    /no credentials/
  )
  await Promise.all([
    writeSelection("codex", "ready"),
    writeSelection("claude", "saved"),
  ])
  assert.equal(await readSelection("codex"), "ready")
  assert.equal(await readSelection("claude"), "saved")
  await writeFile(join(accountsRoot(), "selection", "codex.json"), "broken")
  await assert.rejects(readSelection("codex"), /selection is invalid/)
  await writeSelection("codex", null)
  assert.equal(await readSelection("codex"), null)
  console.log(
    "Account routing rejects missing identities and traversal, preserves default authentication and existing captures"
  )
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(sandbox, { recursive: true, force: true })
}
