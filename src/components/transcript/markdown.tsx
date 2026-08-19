import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Markdown is the most expensive thing in the transcript, and while a message
 * streams it is also the most frequently repeated: parsing the whole answer on
 * every token is O(n) per token, so a long reply costs O(n²) before it lands.
 *
 * The obvious fix — split at blank lines and memoize the settled blocks — is
 * wrong. Markdown is not context-free at a blank line: a list with spaced
 * items would parse as several separate lists, and a setext heading would lose
 * its underline. Correctness has to come first here.
 *
 * So the parse stays whole and is instead *rate-limited* while streaming. The
 * text is re-parsed at most every ~90ms rather than on every token, which caps
 * the cost at a fixed rate regardless of answer length, and settles
 * immediately the moment the message finishes. Nobody reads faster than the
 * refresh, so the throttle is invisible.
 */
const STREAM_FRAME_MS = 90

export const Prose = memo(function Prose({
  text,
  streaming,
  className,
}: {
  text: string
  className?: string
  /** While true the parse is rate-limited rather than run per token. */
  streaming?: boolean
}) {
  const source = useThrottled(text, Boolean(streaming))

  return (
    <div className={cn("pi-prose", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  )
})

/** Latest value, but no more often than one frame per `STREAM_FRAME_MS`. */
function useThrottled(text: string, active: boolean): string {
  const [shown, setShown] = useState(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef(text)

  // A settled message renders its exact text with no delay. Adjusting during
  // render rather than in an effect avoids the extra pass a cascading setState
  // would cost on the frame the turn completes.
  if (!active && shown !== text) {
    setShown(text)
  }

  useEffect(() => {
    pending.current = text
    if (!active || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setShown(pending.current)
    }, STREAM_FRAME_MS)
  }, [active, text])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return shown
}

const components = {
  pre: CodeBlock,
  a: ({ href, children }: ComponentProps<"a">) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
} satisfies Parameters<typeof Markdown>[0]["components"]

/**
 * A fenced code block.
 *
 * The language label and the copy button live in a real header row rather than
 * floating over the code. The previous version positioned them absolutely and
 * tried to reserve space with a `pt-6` utility — which silently lost, because
 * `.pi-prose pre` is a class-plus-element selector and outranks a single
 * utility class. The label then sat on top of the first line. Laying the
 * header out in normal flow removes the specificity fight entirely.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const source = extractText(children)
  const language = extractLanguage(children)

  return (
    <div className="pi-code group">
      <div className="pi-code-head">
        <span className="font-mono text-[10px] tracking-wide text-faint select-none">
          {language ?? "text"}
        </span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(source)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          className={cn(
            "pressable ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-[10px]",
            "text-faint opacity-0 transition-opacity duration-150",
            "group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          )}
        >
          {copied ? (
            <CheckIcon className="size-3 text-positive" />
          ) : (
            <CopyIcon className="size-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function extractText(node: ReactNode): string {
  return Children.toArray(node).map(extractChildText).join("")
}

function extractChildText(node: ReactNode): string {
  if (isElementWithChildren(node)) return extractText(node.props.children)
  return String(node)
}

function isElementWithChildren(
  node: ReactNode
): node is ReactElement<{ children?: ReactNode }> {
  return isValidElement<{ children?: ReactNode }>(node)
}

function extractLanguage(node: ReactNode): string | null {
  if (!isCodeElement(node)) return null
  const match = /language-([\w+-]+)/.exec(node.props.className ?? "")
  return match?.[1] ?? null
}

function isCodeElement(
  node: ReactNode
): node is ReactElement<ComponentProps<"code">, "code"> {
  return isValidElement<ComponentProps<"code">>(node) && node.type === "code"
}
