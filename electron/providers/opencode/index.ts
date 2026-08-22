import type { ProviderModule } from "../host.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProfileLoader } from "./profile.js"

export const installOpenCode: ProviderModule = (host) => {
  host.nativeRunners.register(openCodeNativeRunner)
  host.profiles.register(openCodeProfileLoader)
}
