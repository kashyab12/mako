import type { Readable, Writable } from "node:stream"

/** Node pipe bytes at the SDK's Web Streams boundary, with backpressure. */
export function acpReadable(pipe: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      pipe.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk)
        if ((controller.desiredSize ?? 0) <= 0) pipe.pause()
      })
      pipe.once("end", () => controller.close())
      pipe.once("error", (error) => controller.error(error))
    },
    pull() {
      pipe.resume()
    },
    cancel() {
      pipe.destroy()
    },
  })
}

export function acpWritable(pipe: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        pipe.write(chunk, (error) => (error ? reject(error) : resolve()))
      })
    },
    close() {
      pipe.end()
    },
    abort() {
      pipe.destroy()
    },
  })
}
