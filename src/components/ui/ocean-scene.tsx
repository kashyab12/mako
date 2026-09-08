import { useEffect, useRef } from "react"
import { usePrefs, type OceanTone } from "@/state/prefs"
import { OceanFin } from "./ocean-fin"

/** The engraving stays still. A small, blended light layer moves over the water. */
export function OceanScene({
  tone,
  animated,
}: {
  tone?: OceanTone
  animated?: boolean
}) {
  const preference = usePrefs((prefs) => prefs.oceanTone)
  const motionPreference = usePrefs((prefs) => prefs.oceanMotion)
  const motion = animated ?? motionPreference
  const scene = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scene.current
    if (!element) return
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    let visible = false
    const update = () => {
      element.toggleAttribute(
        "data-water-moving",
        motion && visible && !document.hidden && !media.matches
      )
    }
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      update()
    })
    intersection.observe(element)
    media.addEventListener("change", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      intersection.disconnect()
      media.removeEventListener("change", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [motion])
  return (
    <div
      ref={scene}
      className="ocean-scene"
      data-ocean-tone={tone ?? preference}
      aria-hidden="true"
    >
      <img
        className="ocean-engraving"
        src="/artwork/mako-ocean-engraving.webp"
        width={1536}
        height={1024}
        alt=""
        decoding="async"
      />
      <span className="ocean-grain" />
      <span className="ocean-light">
        <img
          className="ocean-engraving"
          src="/artwork/mako-ocean-engraving.webp"
          width={1536}
          height={1024}
          alt=""
          decoding="async"
        />
      </span>
      <OceanFin />
    </div>
  )
}
