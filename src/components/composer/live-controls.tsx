import { AgentsToggle } from "@/components/inspector/agents-panel"
import { useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, MoreHorizontalIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react"
import { ACCESS_TIERS, accessTierInfo } from "../../../electron/contracts/access"
import type { LiveSessionMode } from "@/lib/types"
import { steeringSummary } from "@/components/composer/steering"
import { setPref, usePrefs } from "@/state/prefs"
import { useThreads } from "@/state/threads"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ConversationRelations } from "@/components/viewer/conversation-relations"
import { TransferStatus } from "@/components/viewer/transfer-status"
import { LiveActionStatus } from "@/components/viewer/live-action-status"
import { CaptureNotice } from "@/components/viewer/capture-notice"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"

export function LiveComposerControls({
  canCompact,
  compactEnabled,
}: {
  canCompact: boolean
  compactEnabled: boolean
}) {
  const connected = useAcp(
    (state) => activeLiveAcp(state)?.session.connection === "connected"
  )
  const conversationId = useAcp((state) => state.activeKey)
  const [open, setOpen] = useState(false)
  return (
    <>
      <ModePicker />
      <AgentsToggle />
      <ConversationRelations key={conversationId} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Conversation actions"
            title="Conversation actions"
            className="pressable flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="max-h-[60vh] w-80 overflow-y-auto p-1"
        >
          {canCompact ? (
            <button
              type="button"
              disabled={!compactEnabled}
              onClick={() => {
                setOpen(false)
                void acp.compact()
              }}
              className="pressable flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-fill-hover disabled:opacity-40"
            >
              <span className="text-ui">Compact conversation</span>
              <span className="text-label text-faint">
                Summarize history to free context
              </span>
            </button>
          ) : null}
          <SteeringPreference />
          <TransferStatus history />
          <LiveActionStatus history />
          {!connected ? <CaptureNotice /> : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              acp.close()
            }}
            className="pressable flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-fill-hover"
          >
            <span className="text-ui">End live session</span>
            <span className="text-label text-faint">
              Keep this conversation in Threads
            </span>
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** Whether Enter steers the running turn, shown only where the provider can take one. */
export function SteeringPreference() {
  const harness = useAcp((state) => activeAcp(state)?.harness ?? null)
  const capability = useThreads((state) =>
    state.liveCapabilities.find((item) => item.provider === harness)
  )
  const steerOnEnter = usePrefs((state) => state.steerOnEnter)
  if (!capability?.canSteer) return null
  return (
    <label className="pressable flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-fill-hover">
      <input
        type="checkbox"
        className="mt-1 size-3.5 shrink-0 accent-foreground"
        checked={steerOnEnter}
        onChange={(event) => setPref("steerOnEnter", event.target.checked)}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui">Enter steers the running turn</span>
        <span className="text-label text-faint">
          {steeringSummary(capability.steering ?? null)} Cmd+Enter does the other.
        </span>
      </span>
    </label>
  )
}

const TIER_ORDER = new Map(ACCESS_TIERS.map((info, index) => [info.tier, index]))

/** The ladder first, in a fixed order; a provider's own unplaced modes after it. */
function orderedModes(modes: readonly LiveSessionMode[]): LiveSessionMode[] {
  return [...modes].sort((left, right) => {
    const a = left.access ? (TIER_ORDER.get(left.access) ?? 99) : 100
    const b = right.access ? (TIER_ORDER.get(right.access) ?? 99) : 100
    return a - b
  })
}

function modeLabel(mode: LiveSessionMode): string {
  return mode.access ? accessTierInfo(mode.access).label : mode.name
}

/**
 * The provider's own name for a tier when it differs, and who enforces it.
 * "Mako approves" is stated rather than hidden: the agent still asks, and
 * the host answers on the user's behalf.
 */
function modeDetail(mode: LiveSessionMode, harness: string): string | null {
  const parts: string[] = []
  if (mode.access && mode.name !== accessTierInfo(mode.access).label)
    parts.push(`${harness}: ${mode.name}`)
  if (mode.enforcement === "host") parts.push("Mako approves the agent's requests")
  if (mode.enforcement === "launch") parts.push("Set when the session starts")
  if (!mode.access && mode.description) parts.push(mode.description)
  return parts.length ? parts.join(" · ") : null
}

/** The ladder as a list, rendered inside the picker and testable on its own. */
export function AccessModeList({
  modes,
  current,
  harness,
  onSelect,
}: {
  modes: readonly LiveSessionMode[]
  current: string | null
  harness: string
  onSelect: (modeId: string) => void
}) {
  return (
    <RadioGroup.Root aria-label="Access" value={current ?? ""} onValueChange={onSelect}>
      {orderedModes(modes).map((mode) => {
        const detail = modeDetail(mode, harness)
        const summary = mode.access ? accessTierInfo(mode.access).summary : null
        return (
          <RadioGroup.Item
            key={mode.id}
            value={mode.id}
            className="pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover data-[state=checked]:bg-fill-selected"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui">
                {mode.access === "full" ? (
                  <TriangleAlertIcon className="size-3 shrink-0 text-caution" />
                ) : null}
                <span className="truncate">{modeLabel(mode)}</span>
              </span>
              {summary ? <span className="text-label text-faint">{summary}</span> : null}
              {detail ? <span className="text-label text-faint">{detail}</span> : null}
            </span>
            <RadioGroup.Indicator className="mt-0.5">
              <CheckIcon className="size-3.5" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        )
      })}
    </RadioGroup.Root>
  )
}

function ModePicker() {
  const modes = useAcp((state) => activeLiveAcp(state)?.session.modes)
  const current = useAcp((state) => activeLiveAcp(state)?.session.currentMode)
  const harness = useAcp((state) => activeLiveAcp(state)?.harness ?? "")
  const [open, setOpen] = useState(false)
  if (!modes?.length) return null
  const selected = modes.find((mode) => mode.id === current)
  const label = selected ? modeLabel(selected) : "Access"
  const full = selected?.access === "full"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Access: ${label}`}
          title={selected ? (modeDetail(selected, harness) ?? label) : "Choose what the agent may do without asking"}
          className="pressable flex h-7 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          {full ? (
            <TriangleAlertIcon className="size-3 shrink-0 text-caution" />
          ) : (
            <ShieldIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">Access</p>
        <AccessModeList
          modes={modes}
          current={current ?? null}
          harness={harness}
          onSelect={(value) => {
            void acp.setMode(value)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
