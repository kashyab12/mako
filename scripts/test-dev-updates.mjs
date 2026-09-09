import assert from "node:assert/strict"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

const sent = []
const channel = { send: (...args) => sent.push(args) }
manualDevUpdates().configureServer({ environments: { client: { hot: channel } } })
for (const payload of [
  { type: "update", updates: [{ path: "/src/components/composer/composer.tsx", type: "js-update" }] },
  { type: "update", updates: [{ path: "/src/index.css", type: "css-update" }] },
  { type: "full-reload", path: "/index.html" },
]) {
  channel.send(payload)
  assert.equal(sent.at(-1)[0].type, "custom")
  assert.equal(sent.at(-1)[0].event, "mako:update-available")
  assert.equal(sent.at(-1)[0].data.kind, "available")
}
channel.send({ type: "connected" })
assert.deepEqual(sent.at(-1), [{ type: "connected" }])
channel.send("custom-event", { value: 1 })
assert.deepEqual(sent.at(-1), ["custom-event", { value: 1 }])
assert.equal(sent.some(([payload]) => payload.type === "update" || payload.type === "full-reload"), false)
console.log("Development updates: JS, CSS, and HTML changes notify without applying or reloading; connection and custom events remain intact")
