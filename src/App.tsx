import { AppShell } from "@/components/shell/app-shell"
import { Toaster } from "@/components/ui/sonner"

export function App() {
  return (
    <>
      <AppShell />
      <Toaster position="bottom-right" offset={16} />
    </>
  )
}

export default App
