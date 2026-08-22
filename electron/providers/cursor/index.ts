import type { ProviderModule } from "../host.js"
import { cursorNativeRunner } from "./native-runner.js"

export const installCursor: ProviderModule = (host) => {
  host.nativeRunners.register(cursorNativeRunner)
}
