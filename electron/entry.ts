if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.env.MAKO_HOST_ONLY === "1" ? "host" : "client")
if (process.env.MAKO_HOST_ONLY === "1" || process.env.MAKO_STANDALONE === "1") {
  if (process.env.MAKO_DATA_ROOT) {
    const { app } = await import("electron")
    app.setPath("userData", process.env.MAKO_DATA_ROOT)
  }
  await import("./main.js")
} else {
  await import("./client-main.js")
}
export {}
