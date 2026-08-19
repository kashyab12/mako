import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm"

const FILE_PATH = /(?:^|\s)((?:\/|\.\.\/|\.\/)?(?:[\w@+,. -]+\/)+[\w@+,. -]+(?:\.[\w-]+)?(?::\d+(?::\d+)?)?)/g
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/

export interface TerminalFileLink {
  path: string
  line?: number
}

export function parseTerminalFileLink(text: string): TerminalFileLink {
  const match = LOCATION.exec(text)
  const path = match?.[1] ?? text
  const line = Number(match?.[2])
  return Number.isInteger(line) && line > 0 ? { path, line } : { path }
}

export function createTerminalFileLinks(
  terminal: Terminal,
  open: (link: TerminalFileLink) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active
        .getLine(bufferLineNumber - 1)
        ?.translateToString(true)
      if (!line) {
        callback(undefined)
        return
      }
      const links: ILink[] = []
      for (const match of line.matchAll(FILE_PATH)) {
        const text = match[1]
        if (!text || match.index === undefined) continue
        const leading = match[0].length - text.length
        const start = match.index + leading + 1
        links.push({
          text,
          range: {
            start: { x: start, y: bufferLineNumber },
            end: { x: start + text.length - 1, y: bufferLineNumber },
          },
          activate: (event) => {
            if (!event.metaKey && !event.ctrlKey) return
            open(parseTerminalFileLink(text))
          },
        })
      }
      callback(links.length > 0 ? links : undefined)
    },
  }
}
