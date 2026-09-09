export function manualDevUpdates() {
  return {
    name: "mako-manual-updates",
    configureServer(server) {
      const channel = server.environments.client.hot
      const send = channel.send.bind(channel)
      channel.send = (...args) => {
        const payload = args[0]
        if (payload?.type === "update" || payload?.type === "full-reload") {
          send({
            type: "custom",
            event: "mako:update-available",
            data: {
              files: payload.type === "update"
                ? payload.updates.map((update) => update.path)
                : [payload.path ?? "index.html"],
              at: Date.now(),
              kind: "available",
            },
          })
          return
        }
        send(...args)
      }
    },
  }
}
