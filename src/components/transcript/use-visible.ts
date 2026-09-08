import { useEffect, useRef, useState } from "react"

/** Heavy transcript previews start only when close to the reading viewport. */
export function useVisible() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, {rootMargin: "240px"})
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])
  return {ref, visible}
}
