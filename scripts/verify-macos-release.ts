import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const release = resolve(process.cwd(), "release")
const app = join(release, "mac-arm64", "Mako.app")
const dmg = join(release, "Mako-arm64.dmg")
const zip = join(release, "Mako-arm64.zip")
const notarized = process.argv.includes("--notarized")

for (const path of [
  app,
  dmg,
  `${dmg}.blockmap`,
  zip,
  `${zip}.blockmap`,
  join(release, "latest-mac.yml"),
]) {
  assert.ok(existsSync(path), `Missing release artifact: ${path}`)
}

const executable = join(app, "Contents", "MacOS", "Mako")
const { stdout: executableType } = await run("file", [executable])
assert.match(executableType, /Mach-O 64-bit executable arm64/)
const { stdout: bundleIdentifier } = await run("plutil", [
  "-extract",
  "CFBundleIdentifier",
  "raw",
  "-o",
  "-",
  join(app, "Contents", "Info.plist"),
])
assert.equal(bundleIdentifier.trim(), "dev.mako.app")
await run("codesign", [
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  app,
])

if (notarized) {
  await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app])
  await run("xcrun", ["stapler", "validate", app])
  await run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmg,
  ])
}

const mount = await mkdtemp(join(tmpdir(), "mako-dmg-"))
let attached = false
try {
  await run("hdiutil", [
    "attach",
    dmg,
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
  ])
  attached = true
  assert.ok(lstatSync(join(mount, "Mako.app")).isDirectory())
  assert.ok(lstatSync(join(mount, "Applications")).isSymbolicLink())
  assert.equal(readlinkSync(join(mount, "Applications")), "/Applications")
} finally {
  if (attached) await run("hdiutil", ["detach", mount]).catch(() => undefined)
  await rm(mount, { recursive: true, force: true })
}

const { stdout: archiveEntries } = await run(
  join(process.cwd(), "node_modules", ".bin", "asar"),
  ["list", join(app, "Contents", "Resources", "app.asar")],
  { maxBuffer: 16 * 1024 * 1024 }
)
assert.match(
  archiveEntries,
  /node_modules\/@mako\/sessions\/dist\/index\.js/
)
const { stdout: zipEntries } = await run("unzip", ["-Z1", zip], {
  maxBuffer: 16 * 1024 * 1024,
})
assert.match(zipEntries, /^Mako\.app\//m)

console.log(
  `macOS release artifacts passed architecture, identity, DMG layout, ZIP, and${
    notarized ? " notarization" : " unsigned-release"
  } checks`
)
