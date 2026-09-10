import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyBuildSource } from "../electron/local-updates.js"

const root = await mkdtemp(join(tmpdir(), "mako-source-copy-"))
try {
  const source = join(root, "source")
  const isolated = join(root, "isolated")
  await mkdir(join(source, "node_modules/@mako"), { recursive: true })
  await mkdir(join(source, "packages/sessions"), { recursive: true })
  await mkdir(join(source, "ignore"))
  await mkdir(join(source, "release"))
  await mkdir(isolated)
  await writeFile(join(source, "packages/sessions/value.txt"), "source")
  await writeFile(join(source, ".npmrc"), "minimum-release-age=10080\n")
  await writeFile(join(source, ".env"), "fixture=not-for-build\n")
  await symlink(
    "../../packages/sessions",
    join(source, "node_modules/@mako/sessions")
  )
  await copyBuildSource(source, isolated)
  assert.equal(
    await realpath(join(isolated, "node_modules/@mako/sessions")),
    await realpath(join(isolated, "packages/sessions"))
  )
  await writeFile(
    join(isolated, "node_modules/@mako/sessions/value.txt"),
    "isolated"
  )
  assert.equal(
    await readFile(join(source, "packages/sessions/value.txt"), "utf8"),
    "source"
  )
  assert.equal(
    await readFile(join(isolated, ".npmrc"), "utf8"),
    "minimum-release-age=10080\n"
  )
  for (const name of [".env", "ignore", "release"])
    await assert.rejects(realpath(join(isolated, name)), { code: "ENOENT" })
  await symlink(
    join(source, "packages/sessions"),
    join(source, "node_modules/escape")
  )
  const second = join(root, "second")
  await mkdir(second)
  await assert.rejects(copyBuildSource(source, second), /leaves the private/)
  console.log(
    "Local build copies preserve workspace links and security configuration, isolate writes, omit excluded roots, and reject escaping dependency links"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
