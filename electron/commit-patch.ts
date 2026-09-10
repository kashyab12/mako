import { withKiriRepository } from "./kiri-engine.js"

export interface CommitPatch { text: string; scope: "staged" | "working-tree"; files: number; warnings: string[] }

export async function collectCommitPatch(cwd: string, signal: AbortSignal): Promise<CommitPatch> {
  return withKiriRepository(cwd, async (repo, client) => {
    if (!repo) throw new Error("This folder is not a Git repository")
    const captured = await repo.prepare(null, {}, signal)
    try {
      const manifest = await client.request({ method: "manifest", prepared: captured.prepared }, signal)
      if (manifest.kind !== "manifest") throw new Error("Kiri returned an invalid evidence manifest")
      const contents = new Map<string, Buffer>()
      for (let offset = 0; offset < manifest.units.length; offset += 8) {
        await Promise.all(manifest.units.slice(offset, offset + 8).map(async (unit) => {
          const chunks: Buffer[] = []
          let position = 0
          while (true) {
            const response = await client.request({ method: "inspect", prepared: captured.prepared, request: { kind: "source", id: unit.id, offset: position, limit: 128_000 } }, signal)
            if (response.kind !== "evidence") throw new Error("Kiri returned an invalid evidence page")
            chunks.push(Buffer.from(response.page.data, response.page.encoding === "base64" ? "base64" : "utf8"))
            if (response.page.next_offset == null) break
            position = response.page.next_offset
          }
          contents.set(unit.id, Buffer.concat(chunks))
        }))
      }
      const sources = new Map<number, Array<{ start: number; id: string }>>()
      for (const unit of manifest.units) for (const source of unit.sources) {
        const entries = sources.get(source.file) ?? []
        entries.push({ start: source.start, id: unit.id })
        sources.set(source.file, entries)
      }
      const files = manifest.files.map((_file, index) => {
        const units = (sources.get(index) ?? []).sort((a, b) => a.start - b.start)
        const bytes = Buffer.concat(units.map(({ id }) => { const bytes = contents.get(id); if (!bytes) throw new Error("An evidence source was not read"); return bytes }))
        const text = bytes.toString("utf8")
        return Buffer.from(text).equals(bytes) ? text : JSON.stringify({ encoding: "base64", patch: bytes.toString("base64") })
      })
      return { text: files.join("\n\n"), files: manifest.files.length, scope: manifest.source === "staged" ? "staged" : "working-tree", warnings: manifest.files.flatMap((file) => file.withheld ? [`Sensitive file omitted: ${Buffer.from(file.path).toString("utf8")}`] : []) }
    } finally { await client.request({ method: "release", prepared: captured.prepared }) }
  })
}
