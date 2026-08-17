/**
 * Subsequence matcher tuned for short identifier-ish strings (model names,
 * command names, file paths). Returns a score plus the matched indices so the
 * caller can highlight; `null` means no match.
 */

export interface FuzzyMatch {
  score: number
  indices: number[]
}

export function fuzzy(needle: string, haystack: string): FuzzyMatch | null {
  if (!needle) return { score: 0, indices: [] }
  const query = needle.toLowerCase()
  const target = haystack.toLowerCase()

  // Fast path: a contiguous hit always beats a scattered one.
  const direct = target.indexOf(query)
  if (direct >= 0) {
    const indices = Array.from({ length: query.length }, (_, i) => direct + i)
    const boundary = direct === 0 || /[^a-z0-9]/.test(target[direct - 1] ?? "")
    return { score: 1000 - direct + (boundary ? 220 : 0), indices }
  }

  const indices: number[] = []
  let score = 0
  let cursor = 0
  let streak = 0
  for (const char of query) {
    const at = target.indexOf(char, cursor)
    if (at < 0) return null
    const boundary = at === 0 || /[^a-z0-9]/.test(target[at - 1] ?? "")
    streak = at === cursor ? streak + 1 : 0
    score += 12 + streak * 8 + (boundary ? 26 : 0) - Math.min(at - cursor, 12)
    indices.push(at)
    cursor = at + 1
  }
  return { score, indices }
}

export function rank<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items
  const scored: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const match = fuzzy(query.trim(), key(item))
    if (match) scored.push({ item, score: match.score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((entry) => entry.item)
}

/** Split a string into matched / unmatched runs for highlight rendering. */
export function segments(text: string, indices: number[]) {
  if (!indices.length) return [{ text, hit: false }]
  const set = new Set(indices)
  const out: Array<{ text: string; hit: boolean }> = []
  let buffer = ""
  let hit = set.has(0)
  for (let i = 0; i < text.length; i += 1) {
    const isHit = set.has(i)
    if (isHit !== hit) {
      if (buffer) out.push({ text: buffer, hit })
      buffer = ""
      hit = isHit
    }
    buffer += text[i]
  }
  if (buffer) out.push({ text: buffer, hit })
  return out
}
