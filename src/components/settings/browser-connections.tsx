import { Action } from "@/components/ui/kit"
import { mcp, useMcp } from "@/state/mcp"
import type { BrowserControlStatus } from "@/lib/types"

function connectionText(
  connection: BrowserControlStatus["connection"]
): string {
  switch (connection.status) {
    case "connected":
      return "Connected. Tasks share this connection and keep separate tabs."
    case "awaiting-approval":
      return "Connecting. Allow the debugging connection in Chrome if prompted."
    case "unavailable":
      return connection.reason
    case "disconnected":
      return "Connect once while Mako and the browser remain open."
  }
}

export function BrowserConnections() {
  const browsers = useMcp((state) => state.browsers)
  return (
    <div className="mb-4 border-y border-hairline py-3">
      <p className="text-ui font-medium">Browser access</p>
      <p className="mt-1 text-label text-faint">
        Chrome may ask again after a connection ends. Computer permissions are
        managed separately below.
      </p>
      {browsers.length === 0 ? (
        <p className="mt-3 text-ui text-muted-foreground">
          Open a local Chromium browser to set up browser access.
        </p>
      ) : (
        browsers.map((browser) => (
          <div key={browser.id} className="mt-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-ui">{browser.name}</p>
              <p
                role="status"
                className="mt-0.5 text-label text-muted-foreground"
              >
                {connectionText(browser.connection)}
              </p>
            </div>
            {browser.connection.status === "connected" ||
            browser.connection.status === "awaiting-approval" ? (
              <Action
                tone="outline"
                onClick={() => void mcp.disconnectBrowser(browser.id)}
              >
                {browser.connection.status === "awaiting-approval"
                  ? "Cancel connection"
                  : "Disconnect"}
              </Action>
            ) : (
              <Action
                tone="outline"
                onClick={() => void mcp.connectBrowser(browser.id)}
              >
                Connect
              </Action>
            )}
          </div>
        ))
      )}
    </div>
  )
}
