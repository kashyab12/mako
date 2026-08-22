import type { ProviderModule } from "../host.js"
import { grokNativeRunner } from "./native-runner.js"

export const installGrok: ProviderModule = (host) => {
  host.nativeRunners.register(grokNativeRunner)
}
