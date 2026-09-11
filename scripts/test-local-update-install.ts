import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { installerControls } from "../electron/local-update-install.js"
import { basename } from "node:path"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bundleProcessIds,
  completeLocalInstall,
  desktopLaunchEnvironment,
  replacePreparedApplication,
  runningBundleProcesses,
  type LocalInstallReceipt,
} from "../electron/local-update-installer.js"

const root = await mkdtemp(join(tmpdir(), "mako-install-test-"))
async function fixture(name: string) {
  const staging = join(root, name, "stage")
  const target = join(root, name, "Mako.app")
  await mkdir(join(staging, "Mako.app"), { recursive: true })
  await mkdir(target)
  await writeFile(join(target, "identity"), "old")
  await writeFile(join(staging, "Mako.app/identity"), "new")
  return { staging, target, ready: async () => {} }
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
  assert.ok(backup)
  assert.equal(await readFile(join(backup, "identity"), "utf8"), "old")
  const rollback = await fixture("rollback")
  await mkdir(join(rollback.staging, "Failed Mako.app"))
  await writeFile(join(rollback.staging, "Failed Mako.app/keep"), "retained")
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
  const failedDirectory = (await readdir(rollback.staging)).find((name) =>
    name.startsWith("failed-")
  )
  assert.ok(failedDirectory)
  assert.equal(
    await readFile(
      join(rollback.staging, failedDirectory, "Mako.app/identity"),
      "utf8"
    ),
    "new"
  )
  assert.equal(
    await readFile(join(rollback.staging, "Failed Mako.app/keep"), "utf8"),
    "retained"
  )
  const changed = await fixture("changed-during-verification")
  await assert.rejects(
    replacePreparedApplication({
      ...changed,
      verify: async (path) => {
        if (path !== join(changed.staging, "Mako.app")) return
        await rename(changed.target, join(root, "externally-moved.app"))
        await mkdir(changed.target)
        await writeFile(join(changed.target, "identity"), "concurrent app")
      },
    }),
    /changed/
  )
  assert.equal(
    await readFile(join(changed.target, "identity"), "utf8"),
    "concurrent app"
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
  const blocked = await fixture("became-busy")
  await assert.rejects(
    replacePreparedApplication({
      ...blocked,
      verify: async () => {},
      ready: async () => {
        throw new Error("Mako started")
      },
    }),
    /Mako started/
  )
  assert.equal(await readFile(join(blocked.target, "identity"), "utf8"), "old")
  const concurrent = await fixture("concurrent")
  let entered = () => {}
  const verificationEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstInstall = replacePreparedApplication({
    ...concurrent,
    verify: async (path) => {
      if (path.includes("stage")) {
        entered()
        await held
      }
    },
  })
  await verificationEntered
  try {
    await assert.rejects(
      replacePreparedApplication({ ...concurrent, verify: async () => {} }),
      /Another installer/
    )
  } finally {
    release()
  }
  await firstInstall
  const fresh = await fixture("fresh")
  await rename(fresh.target, join(root, "unused.app"))
  assert.equal(
    await replacePreparedApplication({ ...fresh, verify: async () => {} }),
    null
  )
  const receipts: LocalInstallReceipt[] = []
  await assert.rejects(
    completeLocalInstall({
      replace: async () => "/retained/old.app",
      save: async (receipt) => {
        receipts.push(receipt)
      },
      launch: async () => {
        throw new Error("Launch failed")
      },
    }),
    /Launch failed/
  )
  assert.equal(receipts.at(-1)?.ok, true)
  assert.match(receipts.at(-1)?.message ?? "", /installed.*could not reopen/)
  receipts.length = 0
  await assert.rejects(
    completeLocalInstall({
      replace: async () => {
        throw new Error("Verification failed")
      },
      save: async (receipt) => {
        receipts.push(receipt)
      },
      launch: async () => {},
    }),
    /Verification failed/
  )
  assert.deepEqual(receipts, [{ ok: false, message: "Verification failed" }])
  assert.deepEqual(
    bundleProcessIds(
      "12 /Applications/Mako.app/Contents/MacOS/Mako\n13 Mako\n14 Mako Helper (Renderer)\n15 AnotherApp\n16 mako-terminal-daemon",
      "/Applications/Mako.app"
    ),
    [12, 13, 14]
  )
  const controlled = spawn(process.execPath, ["-e", "let count=0;process.send('ready');process.on('message',m=>{count++;process.send({message:m,count})});setTimeout(()=>{},10000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
  try {
    await once(controlled, "message")
    const controls = installerControls(controlled)
    const received = once(controlled, "message")
    controls.install()
    controls.install()
    controls.cancel()
    assert.deepEqual((await received)[0], { message: "install", count: 1 })
    assert.equal(controlled.killed, false, "Cancellation must not interrupt a dispatched install transaction")
  } finally { controlled.kill() }
  const renamed = spawn(
    process.execPath,
    ["-e", "process.title='renamed-test-process';setTimeout(()=>{},10000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const processes = await runningBundleProcesses(
      `/fixture/${basename(process.execPath)}.app`
    )
    assert.ok(
      renamed.pid && processes.includes(renamed.pid),
      "OS executable names must detect processes whose displayed title changed"
    )
  } finally {
    renamed.kill()
  }
  const polluted = {
    HOME: "/fixture",
    PATH: "/bin",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--inspect",
    MAKO_HOST_ONLY: "1",
    MAKO_PROFILE: "test",
    MAKO_DATA_ROOT: "/test",
    MAKO_CLIENT_ID: "test",
    MAKO_STANDALONE: "1",
    MAKO_WEB_SOCKET: "/test.sock",
    MAKO_WEB_ONLY: "1",
    MAKO_PROD: "1",
    MAKO_KIRI_BINARY: "/test-engine",
    VITE_DEV_SERVER_URL: "http://localhost:1",
  }
  assert.deepEqual(desktopLaunchEnvironment(polluted), {
    HOME: "/fixture",
    PATH: "/bin",
  })
  assert.equal(polluted.MAKO_HOST_ONLY, "1")
  console.log(
    "Local installation: rollback, retained failures, changed-target refusal, exclusive install lock, final running-process check, fresh install and clean desktop environment passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
