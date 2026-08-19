interface TerminalWrite {
  data: string
  sequence: number
}

interface TerminalWriterOptions {
  write: (data: string, done: () => void) => void
  replace: (data: string, done: () => void) => void
  onRendered: (sequence: number) => void
  onError: (error: Error) => void
  schedule?: (flush: () => void) => void
  stallTimeoutMs?: number
}

export interface TerminalWriter {
  push(output: TerminalWrite): void
  replace(output: TerminalWrite): void
  flush(done?: () => void): void
  dispose(): void
}

export function createTerminalWriter({
  write,
  replace,
  onRendered,
  onError,
  schedule = queueMicrotask,
  stallTimeoutMs = 10_000,
}: TerminalWriterOptions): TerminalWriter {
  let queued: TerminalWrite[] = []
  let replacement: TerminalWrite | undefined
  let waiting: Array<() => void> = []
  let scheduled = false
  let writing = false
  let disposed = false
  let writeGeneration = 0
  let stallTimer: ReturnType<typeof setTimeout> | undefined

  const settle = () => {
    if (scheduled || writing || queued.length > 0 || replacement) return
    const listeners = waiting
    waiting = []
    for (const listener of listeners) listener()
  }

  const run = () => {
    if (disposed || writing) return
    scheduled = false
    const nextReplacement = replacement
    replacement = undefined
    const batch = nextReplacement ? [] : queued
    if (!nextReplacement) queued = []
    const last = nextReplacement ?? batch.at(-1)
    if (!last) {
      settle()
      return
    }
    writing = true
    const generation = ++writeGeneration
    const continueWriting = () => {
      if (replacement || queued.length > 0) requestRun()
      else settle()
    }
    const done = () => {
      if (generation !== writeGeneration) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = undefined
      writing = false
      if (!disposed) onRendered(last.sequence)
      continueWriting()
    }
    stallTimer = setTimeout(() => {
      if (generation !== writeGeneration || disposed) return
      writeGeneration += 1
      stallTimer = undefined
      writing = false
      onError(new Error("Terminal renderer stopped acknowledging output"))
      continueWriting()
    }, stallTimeoutMs)
    try {
      if (nextReplacement) {
        replace(nextReplacement.data, done)
      } else {
        write(batch.map((entry) => entry.data).join(""), done)
      }
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = undefined
      writeGeneration += 1
      writing = false
      onError(error instanceof Error ? error : new Error(String(error)))
      continueWriting()
    }
  }

  function requestRun() {
    if (scheduled || writing || disposed) return
    scheduled = true
    schedule(run)
  }

  return {
    push(output) {
      if (disposed) return
      queued.push(output)
      requestRun()
    },
    replace(output) {
      if (disposed) return
      queued = []
      replacement = output
      requestRun()
    },
    flush(done) {
      if (done) waiting.push(done)
      if (!scheduled && !writing && queued.length === 0 && !replacement) {
        settle()
        return
      }
      run()
    },
    dispose() {
      disposed = true
      writeGeneration += 1
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = undefined
      queued = []
      replacement = undefined
      waiting = []
    },
  }
}
