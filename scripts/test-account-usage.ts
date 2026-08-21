import assert from "node:assert/strict"
import { classifyCodexWindows, type UsageWindow } from "../electron/accounts"

const fiveHour: UsageWindow = {
  usedPercent: 40,
  windowMinutes: 300,
  resetsAt: 1,
}
const week: UsageWindow = {
  usedPercent: 15,
  windowMinutes: 10_080,
  resetsAt: 2,
}

assert.deepEqual(classifyCodexWindows([week]), {
  session: null,
  weekly: week,
})
assert.deepEqual(classifyCodexWindows([week, fiveHour]), {
  session: fiveHour,
  weekly: week,
})

console.log("Account usage window classification passed")
