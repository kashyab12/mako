import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { startWebHost } from "../electron/web-host.ts"
import { invokeRuntime, runtimeInfo, subscribeRuntime } from "../electron/runtime-connection.ts"
import { hostCallInputs } from "../electron/contracts/host-call-inputs.ts"

const root = await mkdtemp(join(tmpdir(), "mako-wire-"))
const socket = join(root, "host.sock")
const a = randomUUID()
const b = randomUUID()
const framesA: unknown[] = []
const framesB: unknown[] = []
const received: unknown[][] = []
const host = await startWebHost(socket, async (channel, args, client) => {
  if (channel === "mako:live-start") hostCallInputs[channel].parse(args)
  received.push(args)
  return JSON.stringify({ok:true,value:{args,client}})
}, async () => new Response("fixture"), undefined, {protocol:1,instanceId:randomUUID(),pid:process.pid,version:"fixture",methods:["mako:echo", "mako:live-start"]})
const wait = async (predicate:()=>boolean) => { const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error("Transport did not settle");await new Promise(resolve=>setTimeout(resolve,5))} }
const closeA = subscribeRuntime(socket,a,(frame)=>framesA.push(frame),()=>{})
const closeB = subscribeRuntime(socket,b,(frame)=>framesB.push(frame),()=>{})
try {
  assert.equal((await runtimeInfo(socket))?.pid,process.pid)
  await wait(()=>framesA.length===1&&framesB.length===1)
  assert.deepEqual(await invokeRuntime(socket,a,"mako:echo",["text",undefined]),{args:["text",null],client:`web:${a}`})
  assert.deepEqual(received.at(-1), ["text", undefined])
  const options = {
    conversationId: randomUUID(),
    threadPath: undefined,
    displayPrompt: undefined,
    modeId: undefined,
    tuning: { model: undefined, options: { fast: false, effort: "" } },
    initialRequest: {
      id: randomUUID(), text: "New conversation",
      attachments: [{ name: "fixture.txt", mimeType: "text/plain", size: 0, data: undefined, path: "/fixture/file" }],
    },
  }
  const original = structuredClone(options)
  const validated = hostCallInputs["mako:live-start"].parse(["claude", "/fixture", options])
  await invokeRuntime(socket, a, "mako:live-start", validated)
  assert.deepEqual(received.at(-1), ["claude", "/fixture", {
    conversationId: options.conversationId,
    tuning: { options: { fast: false, effort: "" } },
    initialRequest: { id: options.initialRequest.id, text: "New conversation", attachments: [{ name: "fixture.txt", mimeType: "text/plain", size: 0, path: "/fixture/file" }] },
  }])
  assert.deepEqual(options, original, "Wire encoding must not mutate caller options")
  await invokeRuntime(socket, a, "mako:live-start", hostCallInputs["mako:live-start"].parse([
    "claude", "/fixture", { conversationId: options.conversationId, threadPath: undefined, displayPrompt: undefined, modeId: undefined, tuning: undefined, initialRequest: undefined },
  ]))
  assert.deepEqual(received.at(-1), ["claude", "/fixture", { conversationId: options.conversationId }])
  await invokeRuntime(socket, b, "mako:echo", [undefined, null, false, 0, "", { nested: [{ omitted: undefined, retained: null }, undefined], marker: { kind: "absent" } }])
  assert.deepEqual(received.at(-1), [undefined, null, false, 0, "", { nested: [{ retained: null }, null], marker: { kind: "absent" } }])
  const calls = received.length
  await assert.rejects(invokeRuntime(socket, a, "not-a-mako-channel", []))
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", Array.from({ length: 33 }, () => null)))
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", [1n]), TypeError)
  const circular: unknown[] = []
  circular.push(circular)
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", [circular]), TypeError)
  await assert.rejects(invokeRuntime(socket, a, "mako:live-start", ["claude", "/fixture", { conversationId: options.conversationId, modeId: {} }]), /modeId/)
  assert.equal(received.length, calls, "Invalid calls must fail before host dispatch")
  host.event({type:"notice",level:"info",message:"global"})
  host.event({type:"notice",level:"info",message:"private"},`web:${a}`)
  await wait(()=>framesA.length===3&&framesB.length===2)
  assert.deepEqual(framesB.at(-1),{channel:"event",payload:{type:"notice",level:"info",message:"global"}})
  console.log("Runtime transport: shared health, exact arguments, distinct clients, global events and targeted workspace delivery verified")
} finally {closeA();closeB();host.close();await rm(root,{recursive:true,force:true})}
