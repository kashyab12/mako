import { homedir } from "node:os"
import { join } from "node:path"
import { startBrowserNativeHost } from "./browser-native-host.js"

process.title = "mako-browser-host"
void startBrowserNativeHost(join(homedir(), ".mako", "browser-extension"), process.stdin, process.stdout).catch(() => {
  process.stderr.write("Mako browser connection closed. Reconnect from the extension.\n")
  process.exitCode = 1
  process.stdin.destroy()
})
