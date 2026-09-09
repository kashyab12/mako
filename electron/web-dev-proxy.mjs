import { request as hostRequest } from "node:http"

/** Same-origin browser access; the host itself is reachable only over a private socket. */
export function webHostProxy(socket) {
  return {
    name: "mako-real-host",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__mako/")) return next()
        const origins = new Set(
          server.resolvedUrls?.local.map((url) => new URL(url).origin)
        )
        const path = request.url.slice("/__mako".length)
        const preview = request.method === "GET" && path.startsWith("/file/")
        let origin = request.headers.origin
        if (preview) {
          try {
            origin = new URL(request.headers.referer).origin
          } catch {
            origin = undefined
          }
        }
        const trusted =
          origins.has(origin) &&
          request.headers["sec-fetch-site"] === "same-origin"
        if (
          !trusted ||
          (!preview &&
            (request.method !== "POST" ||
              request.headers["x-mako-client"] !== "web"))
        ) {
          response
            .writeHead(403)
            .end("Mako web access requires this page's origin")
          return
        }
        if (!preview && path !== "/rpc" && path !== "/events") {
          response.writeHead(404).end()
          return
        }
        const headers = { "content-type": "application/json" }
        if (request.headers["x-mako-window"]) headers["x-mako-window"] = request.headers["x-mako-window"]
        if (preview && request.headers.range)
          headers.range = request.headers.range
        const upstream = hostRequest(
          {
            socketPath: socket,
            path,
            method: request.method,
            headers,
          },
          (result) => {
            response.writeHead(result.statusCode ?? 502, {
              ...result.headers,
              "cache-control": "no-store",
            })
            result.pipe(response)
          }
        )
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(503)
          response.end("Start the real Mako host with npm run web")
        })
        response.once("close", () => upstream.destroy())
        request.pipe(upstream)
      })
    },
  }
}
