import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"
import { CheckIcon, MoveRightIcon } from "lucide-react"

/**
 * The moment a conversation changes harnesses, shown.
 *
 * This is the app's headline act — a session that began as one agent's
 * becoming, natively, another's — and it deserves better than a spinner: the
 * two marks, the direction of travel, and plain words about what is being
 * written. The store gives the moment a floor of about a second so it reads
 * as an event, and a beat of ✓ so it reads as a *finished* one.
 */
export function ConversionOverlay() {
  const converting = useThreads((state) => state.converting)
  if (!converting) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-background/60 backdrop-blur-[3px]">
      <div className="overlay-panel flex flex-col items-center gap-4 rounded-2xl px-10 py-8">
        <div className="flex items-center gap-5">
          <span className={cn("transition-opacity duration-300", converting.done && "opacity-40")}>
            <HarnessIcon harness={converting.from} className="size-8" />
          </span>
          <span className="relative flex w-10 items-center justify-center">
            {converting.done ? (
              <CheckIcon className="size-5 text-positive/90" />
            ) : (
              <>
                <MoveRightIcon className="size-5 text-faint" />
                {/* A dot travelling the arrow: the conversation, in transit. */}
                <span className="absolute left-0 size-1 animate-[conversion-travel_0.9s_ease-in-out_infinite] rounded-full bg-foreground/80" />
              </>
            )}
          </span>
          <span
            className={cn(
              "transition-transform duration-300",
              converting.done ? "scale-110" : "scale-100"
            )}
          >
            <HarnessIcon harness={converting.to} className="size-8" />
          </span>
        </div>
        <div className="text-center">
          <p className="text-[13px] font-medium text-foreground">
            {converting.done
              ? `Now a native ${harnessLabel(converting.to)} session`
              : `Becoming a native ${harnessLabel(converting.to)} session`}
          </p>
          <p className="pt-0.5 text-[11px] text-faint">
            {converting.title ? `“${truncate(converting.title, 56)}” — ` : ""}
            {converting.done
              ? "same conversation, full history, ready to continue"
              : `translating the ${harnessLabel(converting.from)} transcript into ${harnessLabel(converting.to)}'s own store`}
          </p>
        </div>
      </div>
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
