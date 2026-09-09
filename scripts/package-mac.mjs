import assert from "node:assert/strict"
import { constants, createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, Platform, Arch } from "electron-builder"
import { extractFile } from "@electron/asar"
import { assertPackagedImports } from "./test-packaged-imports.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
assert.ok(
  args.every((arg) => arg === "--dir" || arg.startsWith("--output=")),
  "Use --dir and/or --output=<directory>"
)
const output = resolve(
  args.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    join(project, "release")
)
const stage = await mkdtemp(join(tmpdir(), "mako-package-inputs-"))
const inputs = [
  "dist",
  "dist-electron",
  "dist-browser-extension",
  "package.json",
  "packages/sessions/package.json",
  "packages/sessions/dist",
  "packages/relay/package.json",
  "packages/relay/dist",
  "mako-icons/_masters/desktop-light.png",
  "mako-icons/_masters/desktop-dark.png",
  "build/Mako.icns",
  "build/entitlements.mac.plist",
]
async function digest(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
async function manifest(root) {
  const files = []
  async function visit(path) {
    const entries = await readdir(join(root, path), {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOTDIR") return null
      throw error
    })
    if (!entries) {
      files.push(path)
      return
    }
    for (const entry of entries) await visit(join(path, entry.name))
  }
  for (const path of inputs) await visit(path)
  const result = []
  for (const path of files.sort())
    result.push({ path, sha256: await digest(join(root, path)) })
  return result
}
try {
  const before = await manifest(project)
  for (const path of inputs) {
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(join(project, path), join(stage, path), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    })
  }
  assert.deepEqual(
    await manifest(stage),
    before,
    "Build output changed while being copied; finish compilation and retry packaging"
  )
  assert.deepEqual(
    await manifest(project),
    before,
    "Build output changed while being copied; finish compilation and retry packaging"
  )
  const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"))
  const config = join(stage, "electron-builder.json")
  await writeFile(
    config,
    JSON.stringify({
      ...pkg.build,
      directories: {
        ...pkg.build.directories,
        output,
        buildResources: join(stage, "build"),
      },
      files: [
        {
          from: stage,
          to: ".",
          filter: [
            "dist/**",
            "dist-electron/**",
            "dist-browser-extension/**",
            "mako-icons/_masters/*.png",
            "package.json",
            "!**/*.map",
          ],
        },
        ...["sessions", "relay"].map((name) => ({
          from: join(stage, "packages", name),
          to: `node_modules/@mako/${name}`,
          filter: ["package.json", "dist/**", "!**/*.map"],
        })),
      ],
      mac: {
        ...pkg.build.mac,
        icon: join(stage, "build/Mako.icns"),
        entitlements: join(stage, "build/entitlements.mac.plist"),
        entitlementsInherit: join(stage, "build/entitlements.mac.plist"),
      },
    })
  )
  await build({
    projectDir: project,
    targets: Platform.MAC.createTarget(
      args.includes("--dir") ? ["dir"] : ["dmg", "zip"],
      Arch.arm64
    ),
    publish: "never",
    config,
  })
  const app = join(output, "mac-arm64", `${pkg.build.productName}.app`)
  const archive = join(app, "Contents/Resources/app.asar")
  const verified = []
  for (const file of before) {
    if (
      file.path === "package.json" ||
      file.path.startsWith("build/") ||
      file.path.endsWith(".map")
    )
      continue
    const target = file.path.replace(
      /^packages\/(sessions|relay)\//,
      "node_modules/@mako/$1/"
    )
    assert.equal(
      createHash("sha256").update(extractFile(archive, target)).digest("hex"),
      file.sha256,
      `Packaged bytes differ from the frozen build: ${target}`
    )
    verified.push({ path: target, sha256: file.sha256 })
  }
  const imports = assertPackagedImports(app)
  await writeFile(
    join(output, "package-inputs.json"),
    JSON.stringify({ app, imports, files: verified }, null, 2)
  )
  console.log(
    `Packaged ${verified.length} verified build files with ${imports} resolved host imports`
  )
} finally {
  await rm(stage, { recursive: true, force: true })
}
