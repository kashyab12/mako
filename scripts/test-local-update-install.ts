import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { replacePreparedApplication } from "../electron/local-update-installer.js"

const root = await mkdtemp(join(tmpdir(), "mako-install-test-"))
async function fixture(name: string) {
  const staging = join(root, name, "stage")
  const target = join(root, name, "Mako.app")
  await mkdir(join(staging, "Mako.app"), { recursive: true })
  await mkdir(target)
  await writeFile(join(target, "identity"), "old")
  await writeFile(join(staging, "Mako.app/identity"), "new")
  return { staging, target }
}
try {
  const success = await fixture("success")
  const backup = await replacePreparedApplication({
    ...success,
    verify: async (path) => {
      assert.equal(await readFile(join(path, "identity"), "utf8"), "new")
    },
  })
  assert.equal(await readFile(join(success.target, "identity"), "utf8"), "new")
  assert.equal(await readFile(join(backup, "identity"), "utf8"), "old")
  const rollback = await fixture("rollback")
  await assert.rejects(
    replacePreparedApplication({
      ...rollback,
      verify: async (path) => {
        if (path === rollback.target) throw new Error("Changed signature")
      },
    }),
    /Changed signature/
  )
  assert.equal(await readFile(join(rollback.target, "identity"), "utf8"), "old")
  assert.equal(
    await readFile(join(rollback.staging, "Failed Mako.app/identity"), "utf8"),
    "new"
  )
  const rejected = await fixture("rejected")
  await assert.rejects(
    replacePreparedApplication({
      ...rejected,
      verify: async () => {
        throw new Error("Untrusted signer")
      },
    }),
    /Untrusted/
  )
  assert.equal(await readFile(join(rejected.target, "identity"), "utf8"), "old")
  const link = join(root, "linked.app")
  await symlink(rejected.target, link)
  await assert.rejects(
    replacePreparedApplication({
      ...rejected,
      target: link,
      verify: async () => {},
    }),
    /regular application/
  )
  console.log(
    "Local installation: verified replacement, previous-app retention, preflight refusal, rollback after failed verification, and symlink rejection passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
