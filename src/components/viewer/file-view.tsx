import { useEffect, useRef } from "react"
import { File, Virtualizer } from "@pierre/diffs/react"
import { usePrefs } from "@/state/prefs"
import type { FileContents } from "@/lib/types"

/**
 * A file, rendered.
 *
 * The `File` renderer, not the diff one. Passing a file to the diff engine as
 * an addition also works and was the first thing I tried — but it means every
 * line arrives green with a `+298` badge above it, which says "here is a large
 * change" about a file nobody changed. Reading is not a diff.
 *
 * The header is disabled because this layer already has one, carrying the path
 * and the actions; two stacked filename bars is the sort of thing that makes an
 * interface feel assembled rather than designed.
 */
export function FileView({ file, line }: { file: FileContents; line?: number }) {
  const theme = usePrefs((prefs) => prefs.theme)
  const host = useRef<HTMLDivElement>(null)

  /**
   * Land on the line you came for.
   *
   * The renderer stamps each row with `data-line`, but it fills the DOM after
   * its own layout pass, so the row is not there on the effect's first tick.
   * A short poll is cheap, ends the moment it finds the row, and gives up
   * rather than spinning if the file is shorter than the line asked for.
   */
  useEffect(() => {
    if (!line) return
    let frames = 0
    let raf = 0
    const look = () => {
      const row = host.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)
      if (row) {
        row.scrollIntoView({ block: "center" })
        return
      }
      if (frames++ > 90) return
      raf = requestAnimationFrame(look)
    }
    raf = requestAnimationFrame(look)
    return () => cancelAnimationFrame(raf)
  }, [file, line])

  if (file.binary) {
    return (
      <p className="p-4 text-[12px] text-faint">
        Binary file, {formatBytes(file.size)}. Nothing to show as text.
      </p>
    )
  }

  return (
    <div ref={host}>
      <Virtualizer className="min-h-full">
        <File
          file={{ name: file.path, contents: file.contents }}
          selectedLines={line ? { start: line, end: line } : null}
          options={{
            themeType: theme === "light" ? "light" : "dark",
            disableFileHeader: true,
          }}
        />
      </Virtualizer>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
