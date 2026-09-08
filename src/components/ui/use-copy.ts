import { useEffect, useRef, useState } from "react"
import { actions } from "@/state/session"

export function useCopy() {
  const [copied, setCopied] = useState(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => {
    generation.current++
    clearTimeout(timer.current)
  }, [])
  const copy = async (text: string) => {
    const current = ++generation.current
    clearTimeout(timer.current)
    setCopied(false)
    const success = await actions.copy(text, { notify: false })
    if (current !== generation.current || !success) return
    setCopied(true)
    timer.current = setTimeout(() => setCopied(false), 1400)
  }
  return { copied, copy }
}
