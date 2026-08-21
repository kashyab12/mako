import assert from "node:assert/strict"
import {
  clampCompanionWidth,
  clampDockHeight,
  fitsBeside,
} from "../src/components/stage/stage-width.ts"
import {
  argAt,
  isSubagentLaunch,
  subagentResultId,
  subagentResultText,
  toolLabel,
} from "../src/lib/tools.ts"

assert.equal(
  clampCompanionWidth({ width: 520, available: 1400, min: 400 }),
  520
)
assert.equal(
  clampCompanionWidth({ width: 520, available: 800, min: 400 }),
  400
)
assert.equal(fitsBeside(851, 400), true)
assert.equal(fitsBeside(850, 400), false)
assert.equal(
  clampDockHeight({ height: 280, available: 900, min: 180 }),
  280
)
assert.equal(
  clampDockHeight({ height: 600, available: 500, min: 180 }),
  240
)
assert.equal(
  clampDockHeight({ height: 120, available: 300, min: 180 }),
  180
)
assert.equal(
  clampDockHeight({ height: 350, available: undefined, min: 180 }),
  350
)

const subagentEnvelope =
  '<subagent sessionID="ses_test" state="completed"> mako </subagent>'
assert.equal(subagentResultId(subagentEnvelope), "ses_test")
assert.equal(subagentResultText(subagentEnvelope), "mako")
assert.equal(
  subagentResultText("<task_result>finished cleanly</task_result>"),
  "finished cleanly"
)
assert.equal(
  subagentResultText("<task_error>failed cleanly</task_error>"),
  "failed cleanly"
)
assert.equal(
  subagentResultText('<subagent sessionID="ses_partial">'),
  "Subagent result was incomplete."
)
assert.equal(argAt('{"description":"Read package name"}', "description"), "Read package name")
assert.equal(
  isSubagentLaunch({ id: "1", name: "TaskUpdate", pending: false }),
  false
)
assert.equal(
  isSubagentLaunch({ id: "2", name: "Subagent", pending: true }),
  true
)
assert.equal(toolLabel("exec_command"), "Shell")
assert.equal(toolLabel("TaskUpdate"), "Update task")

console.log("stage layout, tool mapping, and subagent formatting passed")
