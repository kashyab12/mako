import type { ProviderModule } from "../host.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProfileLoader } from "./profile.js"

export const installDevin: ProviderModule = (host) => {
  host.nativeRunners.register(devinNativeRunner)
  host.profiles.register(devinProfileLoader)
}
