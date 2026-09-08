import assert from "node:assert/strict"
import { cursorCanvasPreview } from "../electron/providers/cursor/canvas-preview.ts"

const document = await cursorCanvasPreview.render(`
import { H1, Pill, Row, Table, useCanvasState } from "cursor/canvas";
export default function Test() {
  const [tab, setTab] = useCanvasState("tab", "Overview");
  return <><H1>Saved document</H1><Row><Pill active={tab === "Overview"} onClick={() => setTab("Overview")}>Overview</Pill><Pill active={tab === "Evidence"} onClick={() => setTab("Evidence")}>Evidence</Pill></Row>{tab === "Evidence" ? <Table headers={["Source"]} rows={[["Retained record"]]}/> : <p>Summary</p>}</>;
}`)
assert.match(document, /default-src 'none'/)
assert.match(document, /connect-src 'none'/)
assert.match(document, /Saved document/)
assert.doesNotMatch(document, /<script[^>]+src=/)
await assert.rejects(cursorCanvasPreview.render('import fs from "node:fs"; export default () => fs.readFileSync("/etc/passwd")'), /Unsupported Canvas import/)
await assert.rejects(cursorCanvasPreview.render('import Secret from "../../secrets"; export default Secret'), /Unsupported Canvas import/)
await assert.rejects(cursorCanvasPreview.render('export default function Empty(){return null}' + " ".repeat(256_000)), /size limit/)
const escaped = await cursorCanvasPreview.render('export default function Example(){return <p>{"</ScRiPt><script>alert(1)</script>"}</p>}')
assert.equal((escaped.match(/<\/script\s*>/gi) ?? []).length, 1, "Source strings cannot escape their script element")
console.log("Canvas compiles without executing source in the host; disk imports, oversized input, and script escapes are blocked")
