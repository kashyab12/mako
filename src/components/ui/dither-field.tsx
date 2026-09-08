import { useEffect, useRef } from "react"

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** A bounded, decorative field. Settles once; never runs behind a conversation. */
export function DitherField() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let visible = false
    let settled = false
    let started = 0
    const draw = (progress: number) => {
      const scale = Math.max(2, canvas.clientWidth / 480, canvas.clientHeight / 320)
      const width = Math.ceil(canvas.clientWidth / scale)
      const height = Math.ceil(canvas.clientHeight / scale)
      if (!width || !height) return
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(canvas).color
      for (let x = 0; x < width; x++) {
        const u = x / width
        const ridge = 0.55 + Math.sin(u * 5 + progress * 0.25) * 0.14
        const strength = Math.sin(u * Math.PI) ** 2 * 0.52
        for (let y = 0; y < height; y++) {
          const v = y / height
          const density = Math.exp(-((v - ridge) ** 2) / 0.025) * strength
          if (density * 16 > ((BAYER[(y % 4) * 4 + x % 4] ?? 0) + 0.5))
            context.fillRect(x, y, 1, 1)
        }
      }
    }
    const tick = (now: number) => {
      frame = 0
      if (!visible || document.hidden) return
      if (!started) started = now
      const progress = media.matches || settled ? 1 : Math.min(1, (now - started) / 220)
      draw(progress)
      settled = progress === 1
      if (!settled) frame = requestAnimationFrame(tick)
    }
    const invalidate = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (visible && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      invalidate()
    })
    const resize = new ResizeObserver(invalidate)
    const theme = new MutationObserver(invalidate)
    intersection.observe(canvas)
    resize.observe(canvas)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    media.addEventListener("change", invalidate)
    document.addEventListener("visibilitychange", invalidate)
    return () => {
      cancelAnimationFrame(frame)
      intersection.disconnect()
      resize.disconnect()
      theme.disconnect()
      media.removeEventListener("change", invalidate)
      document.removeEventListener("visibilitychange", invalidate)
    }
  }, [])
  return <canvas ref={ref} aria-hidden="true" className="dither-field" />
}
