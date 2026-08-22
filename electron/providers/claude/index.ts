import type { ProviderModule } from "../host.js"
import { claudeNativeRunner } from "./native-runner.js"

export const installClaude: ProviderModule = (host) => {
  host.nativeRunners.register(claudeNativeRunner)
}
