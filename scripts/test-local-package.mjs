import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { extractFile } from "@electron/asar"
import { resolveLocalIdentity, verifyLocalSignature } from "./mac-local-signing.mjs"

assert.ok(process.argv[2], "Pass the local Mako.app path and optionally the previous local Mako.app path")
const app = resolve(process.argv[2])
const metadata = JSON.parse(extractFile(join(app, "Contents/Resources/app.asar"), "package.json").toString("utf8"))
assert.equal(metadata.makoDistribution, "local", "The shipped package must identify local signing without enabling public updates")
assert.equal(metadata.main, "dist-electron/entry.js")
const identity = await resolveLocalIdentity(undefined, app)
const signature = await verifyLocalSignature(app, identity, process.argv[3] && resolve(process.argv[3]))
console.log(JSON.stringify({ app, identity, ...signature }, null, 2))
