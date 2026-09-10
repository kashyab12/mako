import { Markdown } from "../node_modules/react-markdown/lib/index.js"
import type { ComponentProps } from "react"
export * from "../node_modules/react-markdown/lib/index.js"

declare global {
  var performanceAuditParses:
    Array<{ chars: number; elapsedMs: number }> | undefined
}

export default function ProbedMarkdown(props: ComponentProps<typeof Markdown>) {
  const start = performance.now()
  const result = Markdown(props)
  globalThis.performanceAuditParses?.push({
    chars: props.children?.length ?? 0,
    elapsedMs: performance.now() - start,
  })
  return result
}
