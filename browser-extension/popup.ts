import { z } from "zod"

const stateSchema = z.object({ enabled: z.boolean().default(true), status: z.string().default("Connecting to Mako…") })
const statusElement = document.querySelector("[role=status]")
const button = document.querySelector("button")
let enabled = true
async function render() {
  const state = stateSchema.parse(await chrome.storage.local.get(["enabled", "status"]))
  enabled = state.enabled
  if (statusElement) statusElement.textContent = state.status
  if (button) button.textContent = enabled ? "Pause browser access" : "Connect to Mako"
}
button?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ kind: "set-enabled", enabled: !enabled }).then(render)
})
chrome.storage.onChanged.addListener(() => void render())
void render()
