import {
  clearCache,
  layout,
  prepare,
  type PreparedText,
} from "@chenglou/pretext"

const cache = new Map<string, PreparedText>()
let retainedCharacters = 0
const CHARACTER_BUDGET = 128_000

/** Estimates only. Native paragraph layout and remembered sizes remain authoritative. */
export function paragraphHeight({
  text,
  font,
  letterSpacing,
  width,
  lineHeight,
}: {
  text: string
  font: string
  letterSpacing: number
  width: number
  lineHeight: number
}) {
  const key = `${font}\0${letterSpacing}\0${text}`
  let prepared = cache.get(key)
  if (!prepared) {
    if (retainedCharacters + key.length > CHARACTER_BUDGET) {
      cache.clear()
      retainedCharacters = 0
      clearCache()
    }
    prepared = prepare(text, font, { letterSpacing })
    cache.set(key, prepared)
    retainedCharacters += key.length
  }
  // The long-identifier benchmark undercounted one line. Keep a conservative
  // initial placeholder; `auto` replaces it with the browser's actual height.
  return layout(prepared, width, lineHeight).height + lineHeight
}
