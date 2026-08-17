import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ErrorBoundary } from "./components/shell/error-boundary.tsx"
import { watchForFailures } from "./desk/failures.ts"

async function start() {
  // `?mock` boots the desk against fixtures so the UI can be worked on in a
  // plain browser. Tree-shaken out of production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installMockBridge } = await import("./dev/mock-bridge.ts")
    installMockBridge()
  }

  watchForFailures()

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}

void start()
