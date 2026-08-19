import type { MakoBridge } from "../../electron/preload.ts"

declare global {
  interface Window {
    mako?: MakoBridge
  }
}

export function hasBridge(): boolean {
  return Boolean(globalThis.window?.mako)
}

export function getMako(): MakoBridge {
  const bridge = globalThis.window?.mako
  if (!bridge) {
    throw new Error("The desktop bridge is unavailable. Launch with `npm run desktop`.")
  }
  return bridge
}
