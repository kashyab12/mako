import { createHook, createStore } from "@/state/store"

/**
 * Notes on the diff, addressed to the agent.
 *
 * This is the shape code review takes when the author is a model: you read
 * what it wrote, and where something is wrong you say so *on the line*, the
 * way you would on a pull request. Then all of it goes back in one message
 * rather than as five rounds of "no, the other one".
 *
 * The alternative — describing the location in prose — is what people
 * currently do, and it is where the friction is. "In the retry helper, the
 * second branch" is a sentence you have to compose and the agent has to
 * resolve. `src/net.ts:42` is neither.
 */

export interface ReviewComment {
  id: string
  workspace: string
  /** Workspace-relative, matching the diff's own paths. */
  path: string
  line: number
  /** Which side of the diff the line is on. */
  side: "additions" | "deletions"
  /** The source line itself, so the message can quote what was meant. */
  code?: string
  body: string
}

export interface Draft {
  workspace: string
  path: string
  line: number
  side: "additions" | "deletions"
  code?: string
  /** Set when editing an existing comment rather than writing a new one. */
  id?: string
}

interface ReviewState {
  comments: ReviewComment[]
  draft?: Draft
}

const KEY = "mako.review.v1"
const LEGACY_KEY = "pi.review.v1"

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]
type StoredValue = JsonValue | undefined

function isJsonObject(value: StoredValue): value is JsonObject {
  return Object(value) === value && !Array.isArray(value)
}

function isJsonArray(value: StoredValue): value is JsonValue[] {
  return Array.isArray(value)
}

function isJsonString(value: StoredValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonNumber(value: StoredValue): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isReviewSide(
  value: StoredValue
): value is ReviewComment["side"] {
  return value === "additions" || value === "deletions"
}

function parseComment(value: JsonValue): ReviewComment | null {
  if (
    !isJsonObject(value) ||
    !isJsonString(value.id) ||
    !isJsonString(value.workspace) ||
    !isJsonString(value.path) ||
    !isJsonNumber(value.line) ||
    !Number.isInteger(value.line) ||
    !isReviewSide(value.side) ||
    !isJsonString(value.body) ||
    (value.code !== undefined && !isJsonString(value.code))
  ) {
    return null
  }
  return {
    id: value.id,
    workspace: value.workspace,
    path: value.path,
    line: value.line,
    side: value.side,
    code: value.code,
    body: value.body,
  }
}

function parseComments(value: JsonValue): ReviewComment[] {
  if (!isJsonArray(value)) return []
  const comments: ReviewComment[] = []
  for (const entry of value) {
    const comment = parseComment(entry)
    if (comment) comments.push(comment)
  }
  return comments
}

/**
 * Persisted, because losing a page of review notes to an accidental reload is
 * the kind of small disaster that stops people trusting a feature. The
 * workspace key keeps identical relative paths in different projects apart.
 */
function load(): ReviewComment[] {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (!raw) return []
    const parsed: JsonValue = JSON.parse(raw)
    return parseComments(parsed)
  } catch {
    return []
  }
}

export const reviewStore = createStore<ReviewState>({ comments: load() })
export const useReview = createHook(reviewStore)

let queued = false
reviewStore.subscribe(() => {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    try {
      localStorage.setItem(KEY, JSON.stringify(reviewStore.get().comments))
    } catch {
      // Storage being unavailable must not break the review itself.
    }
  })
})

let counter = 0
const nextId = () => `c${Date.now().toString(36)}${(counter += 1).toString(36)}`

export const review = {
  start(draft: Draft) {
    reviewStore.set({ draft })
  },

  cancel() {
    reviewStore.set({ draft: undefined })
  },

  /** Save the draft. An empty body deletes rather than storing a blank note. */
  save(body: string) {
    const draft = reviewStore.get().draft
    if (!draft) return
    const text = body.trim()
    const comments = reviewStore.get().comments

    if (draft.id) {
      reviewStore.set({
        comments: text
          ? comments.map((comment) => (comment.id === draft.id ? { ...comment, body: text } : comment))
          : comments.filter((comment) => comment.id !== draft.id),
        draft: undefined,
      })
      return
    }
    reviewStore.set({
      comments: text
        ? [
            ...comments,
            {
              id: nextId(),
              workspace: draft.workspace,
              path: draft.path,
              line: draft.line,
              side: draft.side,
              code: draft.code,
              body: text,
            },
          ]
        : comments,
      draft: undefined,
    })
  },

  edit(comment: ReviewComment) {
    reviewStore.set({
      draft: {
        workspace: comment.workspace,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        code: comment.code,
        id: comment.id,
      },
    })
  },

  remove(id: string) {
    reviewStore.set({ comments: reviewStore.get().comments.filter((c) => c.id !== id) })
  },

  clear(workspace?: string) {
    reviewStore.set({
      comments: workspace
        ? reviewStore
            .get()
            .comments.filter((comment) => comment.workspace !== workspace)
        : [],
      draft: undefined,
    })
  },

  forFile(workspace: string, path: string): ReviewComment[] {
    return reviewStore
      .get()
      .comments.filter(
        (comment) => comment.workspace === workspace && comment.path === path
      )
  },
}

/**
 * The comments as one message.
 *
 * Grouped by file and ordered by line, because that is how they will be acted
 * on. Each note carries the line it is about and the code on that line — the
 * path and number alone are enough for the agent to find it, but quoting the
 * line is what makes the message readable to the person who wrote it too, when
 * it is sitting in their transcript a week later.
 */
export function composeReview(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    const list = byFile.get(comment.path) ?? []
    list.push(comment)
    byFile.set(comment.path, list)
  }

  const blocks: string[] = []
  for (const [path, list] of byFile) {
    const lines = [...list].sort((a, b) => a.line - b.line)
    const notes = lines.map((comment) => {
      const quote = comment.code?.trim()
      return quote
        ? `${path}:${comment.line}\n> ${quote}\n${comment.body}`
        : `${path}:${comment.line}\n${comment.body}`
    })
    blocks.push(notes.join("\n\n"))
  }

  const count = comments.length
  return `${count === 1 ? "One note" : `${count} notes`} on the diff:\n\n${blocks.join("\n\n")}`
}
