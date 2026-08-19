import assert from "node:assert/strict"
import {
  clampCompanionWidth,
  clampDockHeight,
  fitsBeside,
} from "../src/components/stage/stage-width.ts"

assert.equal(
  clampCompanionWidth({ width: 520, available: 1400, min: 400 }),
  520
)
assert.equal(
  clampCompanionWidth({ width: 520, available: 800, min: 400 }),
  400
)
assert.equal(fitsBeside(874, 400), true)
assert.equal(fitsBeside(873, 400), false)
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

console.log("stage side and bottom layout bounds passed")
