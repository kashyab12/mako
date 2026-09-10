import { createRoot } from "react-dom/client"
import { Exchange } from "@/components/transcript/exchange"
import { TooltipProvider } from "@/components/ui/tooltip"

export function mountClipboardQuestion(text: string) {
  const node = document.createElement("div")
  node.id = "clipboard-question"
  document.body.prepend(node)
  const root = createRoot(node)
  root.render(
    <TooltipProvider>
      <Exchange exchange={{
        id: "clipboard-question",
        prompt: { id: "clipboard-question", role: "user", blocks: [{ type: "text", text }] },
        response: [],
        system: [],
      }} />
    </TooltipProvider>
  )
}
