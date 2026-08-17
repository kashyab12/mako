import type { PiBridge } from "../../electron/preload.ts"

declare global {
  interface Window {
    pi?: PiBridge
  }
}

export function hasBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.pi)
}

export function getPi(): PiBridge {
  if (!window.pi) {
    throw new Error("The desktop bridge is unavailable. Launch with `npm run desktop`.")
  }
  return window.pi
}
