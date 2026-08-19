import type { PiBridge } from "../../electron/preload.ts"

declare global {
  interface Window {
    pi?: PiBridge
  }
}

export function hasBridge(): boolean {
  return Boolean(globalThis.window?.pi)
}

export function getPi(): PiBridge {
  const bridge = globalThis.window?.pi
  if (!bridge) {
    throw new Error("The desktop bridge is unavailable. Launch with `npm run desktop`.")
  }
  return bridge
}
