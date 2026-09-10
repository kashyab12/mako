import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { startWebHost } from "../electron/web-host.ts"
import { invokeRuntime, runtimeInfo, subscribeRuntime } from "../electron/runtime-connection.ts"

const root = await mkdtemp(join(tmpdir(), "mako-wire-"))
const socket = join(root, "host.sock")
const a = randomUUID()
const b = randomUUID()
const framesA: unknown[] = []
const framesB: unknown[] = []
const host = await startWebHost(socket, async (_channel, args, client) => JSON.stringify({ok:true,value:{args,client}}), async () => new Response("fixture"), undefined, {protocol:1,instanceId:randomUUID(),pid:process.pid,version:"fixture",methods:["mako:echo"]})
const wait = async (predicate:()=>boolean) => { const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error("Transport did not settle");await new Promise(resolve=>setTimeout(resolve,5))} }
const closeA = subscribeRuntime(socket,a,(frame)=>framesA.push(frame),()=>{})
const closeB = subscribeRuntime(socket,b,(frame)=>framesB.push(frame),()=>{})
try {
  assert.equal((await runtimeInfo(socket))?.pid,process.pid)
  await wait(()=>framesA.length===1&&framesB.length===1)
  assert.deepEqual(await invokeRuntime(socket,a,"mako:echo",["text",undefined]),{args:["text",null],client:`web:${a}`})
  host.event({type:"notice",level:"info",message:"global"})
  host.event({type:"notice",level:"info",message:"private"},`web:${a}`)
  await wait(()=>framesA.length===3&&framesB.length===2)
  assert.deepEqual(framesB.at(-1),{channel:"event",payload:{type:"notice",level:"info",message:"global"}})
  console.log("Runtime transport: shared health, exact arguments, distinct clients, global events and targeted workspace delivery verified")
} finally {closeA();closeB();host.close();await rm(root,{recursive:true,force:true})}
