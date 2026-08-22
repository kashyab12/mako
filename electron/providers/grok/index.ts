import type { ProviderModule } from "../host.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProfileLoader } from "./profile.js"

export const installGrok: ProviderModule = (host) => {
  host.nativeRunners.register(grokNativeRunner)
  host.profiles.register(grokProfileLoader)
}
