import { AppShell } from "@/components/shell/app-shell"
import { Toaster } from "@/components/ui/sonner"

export function App() {
  return (
    <>
      <AppShell />
      <Toaster position="bottom-center" offset={64} />
    </>
  )
}

export default App
