import type { ProviderModule } from "../host.js"
import { codexNativeRunner } from "./native-runner.js"

export const installCodex: ProviderModule = (host) => {
  host.nativeRunners.register(codexNativeRunner)
}
