import { cursorCanvasPreview } from "./canvas-preview.js"
import { acpLiveDriver } from "../acp-live-driver.js"
import { emitCursorSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { cursorAcpSource } from "./acp.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorNativeRunner } from "./native-runner.js"
import { cursorProcessProbe } from "./process-probe.js"
import { cursorProfileLoader } from "./profile.js"
import { cursorSkillSource } from "./skills.js"

export const installCursor: ProviderModule = (host) => {
  host.artifactPreviews.register(cursorCanvasPreview)
  host.nativeRunners.register(cursorNativeRunner)
  host.acpSources.register(cursorAcpSource)
  host.liveDrivers.register(acpLiveDriver(cursorAcpSource))
  host.profiles.register(cursorProfileLoader)
  host.processProbes.register(cursorProcessProbe)
  host.mcpSources.register(cursorMcpSource)
  host.skillSources.register(cursorSkillSource)
  host.sessionEmitters.register({
    provider: "cursor",
    emit: (thread) => emitCursorSession(thread, {}),
  })
}
