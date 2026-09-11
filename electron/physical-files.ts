import * as files from "node:fs/promises"

export async function physicalFiles(): Promise<typeof files> {
  if (!process.versions.electron) return files
  const original = await import("original-fs")
  return original.default.promises
}
