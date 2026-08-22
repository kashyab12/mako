import type { ProviderModule } from "../host.js"
import { openCodeNativeRunner } from "./native-runner.js"

export const installOpenCode: ProviderModule = (host) => {
  host.nativeRunners.register(openCodeNativeRunner)
}
