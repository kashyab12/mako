import { useEffect, useId, useState } from "react"
import type { Root } from "hast"
import { requestProse, cancelProse } from "@/lib/prose-parser-client"

export function useParsedProse(text: string, streaming: boolean) {
  const owner = useId()
  const [result, setResult] = useState<{ text: string; tree: Root } | null>(
    null
  )
  const [failed, setFailed] = useState(false)
  const enabled = streaming && text.length >= 16384 && !failed
  if (!enabled && result) setResult(null)
  useEffect(() => () => cancelProse(owner), [owner, enabled])
  useEffect(() => {
    if (!enabled) return
    return requestProse(owner, text, (tree) => {
      if (tree) setResult({ text, tree })
      else setFailed(true)
    })
  }, [owner, text, enabled])
  return enabled && result && text.startsWith(result.text) ? result : null
}
