import { AgentsToggle } from "@/components/inspector/agents-panel"
import { useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, MoreHorizontalIcon, ShieldIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ConversationRelations } from "@/components/viewer/conversation-relations"
import { TransferStatus } from "@/components/viewer/transfer-status"
import { LiveActionStatus } from "@/components/viewer/live-action-status"
import { CaptureNotice } from "@/components/viewer/capture-notice"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"

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

function ModePicker() {
  const modes = useAcp((state) => activeLiveAcp(state)?.session.modes)
  const current = useAcp((state) => activeLiveAcp(state)?.session.currentMode)
  const [open, setOpen] = useState(false)
  if (!modes?.length) return null
  const label = modes.find((mode) => mode.id === current)?.name ?? "Agent mode"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Agent mode: ${label}`}
          title={label}
          className="pressable flex h-7 max-w-36 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <ShieldIcon className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 p-1"
      >
        <p className="px-2 py-1.5 text-label text-faint">Agent mode</p>
        <RadioGroup.Root
          aria-label="Agent mode"
          value={current ?? ""}
          onValueChange={(value) => {
            acp.setMode(value)
            setOpen(false)
          }}
        >
          {modes.map((mode) => (
            <RadioGroup.Item
              key={mode.id}
              value={mode.id}
              className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-fill-hover data-[state=checked]:bg-fill-selected"
            >
              <span className="min-w-0 flex-1">{mode.name}</span>
              <RadioGroup.Indicator>
                <CheckIcon className="size-3.5" />
              </RadioGroup.Indicator>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </PopoverContent>
    </Popover>
  )
}
