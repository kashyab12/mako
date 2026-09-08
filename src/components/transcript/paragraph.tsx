import { useContext, useEffect, useRef, type ComponentProps } from "react"
import type { ExtraProps } from "react-markdown"
import { ProseStreamingContext } from "./prose-layout-context"

/** Uses the renderer's parsed tree; styled runs, links, and media stay native. */
export function Paragraph({
  node,
  children,
  ...props
}: ComponentProps<"p"> & ExtraProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const streaming = useContext(ProseStreamingContext)
  const child = node?.children.length === 1 ? node.children[0] : undefined
  const text = child?.type === "text" ? child.value : undefined
  useEffect(() => {
    const element = ref.current
    if (
      !element ||
      streaming ||
      !text ||
      text.length < 512 ||
      text.length > 8192
    )
      return
    let disposed = false
    let observer: ResizeObserver | undefined
    void Promise.all([import("@/lib/paragraph-geometry"), document.fonts.ready])
      .then(([geometry]) => {
        if (disposed) return
        observer = new ResizeObserver(([entry]) => {
          const width = entry?.contentRect.width ?? 0
          if (width <= 0) return
          const style = getComputedStyle(element)
          const height = geometry.paragraphHeight({
            text,
            width,
            font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
            lineHeight: Number.parseFloat(style.lineHeight),
            letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
          })
          element.style.containIntrinsicBlockSize = `auto ${Math.ceil(height)}px`
          element.setAttribute("data-estimated-paragraph", "")
        })
        observer.observe(element)
      })
      .catch(() => {
        // Loading an optional estimator cannot interrupt a readable answer.
      })
    return () => {
      disposed = true
      observer?.disconnect()
      element.style.removeProperty("contain-intrinsic-block-size")
      element.removeAttribute("data-estimated-paragraph")
    }
  }, [streaming, text])
  return (
    <p {...props} ref={ref}>
      {children}
    </p>
  )
}
