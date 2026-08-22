import type { ProviderModule } from "../host.js"
import { devinNativeRunner } from "./native-runner.js"

export const installDevin: ProviderModule = (host) => {
  host.nativeRunners.register(devinNativeRunner)
}
