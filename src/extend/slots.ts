import type { ComponentType, ReactNode } from "react"
import { Registry, useRegistry } from "@/extend/registry"
import type { GitFile, PiMessage, SessionMeta, SessionSummary } from "@/lib/types"
import type { Checkpoint } from "@/lib/thread"

/** A slot whose contributions receive nothing from the render site. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NoProps {}

/**
 * Slots are the desk's declared seams. This map is the contract: adding a key
 * here is what authorizes anything to render there, and each key names the
 * exact props its contributions receive — so a contribution can never guess
 * wrong about what it is handed, and a render site can never invent a seam
 * nobody declared.
 */
export interface SlotMap {
  "titlebar.leading": NoProps
  "titlebar.trailing": NoProps
  "rail.header": NoProps
  "rail.footer": NoProps
  "rail.session.trailing": { session: SessionSummary; active: boolean }
  "transcript.header": { meta?: SessionMeta }
  "transcript.empty": { meta?: SessionMeta }
  "transcript.turn.trailing": { message: PiMessage }
  "composer.controls": { meta?: SessionMeta; disabled: boolean }
  "composer.trailing": { meta?: SessionMeta; disabled: boolean }
  "composer.above": { meta?: SessionMeta }
  "inspector.history.trailing": { checkpoint: Checkpoint }
  "inspector.changes.file.trailing": { file: GitFile }
  "statusbar.trailing": { meta?: SessionMeta }
}

export type SlotName = keyof SlotMap

export interface Contribution {
  slot: SlotName
  order: number
  render: ComponentType<never>
}

export const contributions = new Registry<Contribution>()

/** Contribute a component into a declared slot. Returns a disposer. */
export function registerSlot<K extends SlotName>(
  id: string,
  slot: K,
  render: ComponentType<SlotMap[K]>,
  order = 0
) {
  return contributions.register(`${slot}:${id}`, {
    slot,
    order,
    render: render as ComponentType<never>,
  })
}

/* ------------------------------------------------------------------ */
/* tool views                                                          */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string
  name: string
  arguments?: unknown
  result?: string
  isError?: boolean
  pending: boolean
}

export interface ToolViewProps {
  call: ToolCall
  expanded: boolean
}

export interface ToolView {
  /** One-line summary shown on the collapsed row. */
  summary?: (call: ToolCall) => ReactNode
  /** Body shown when the row is expanded. Falls back to raw output. */
  body?: ComponentType<ToolViewProps>
  /** Overrides the default wrench glyph. */
  icon?: ComponentType<{ className?: string }>
}

const toolViews = new Registry<ToolView>()

export function registerToolView(name: string, view: ToolView) {
  return toolViews.register(name, view)
}

export function useToolView(name: string): ToolView | undefined {
  return useRegistry(toolViews).get(name)
}

/* ------------------------------------------------------------------ */
/* inspector panels                                                    */
/* ------------------------------------------------------------------ */

export interface InspectorPanel {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
  render: ComponentType<NoProps>
  order?: number
}

export const inspectorPanels = new Registry<InspectorPanel>()

export function registerInspectorPanel(panel: InspectorPanel) {
  return inspectorPanels.register(panel.id, panel)
}

export function useInspectorPanels(): InspectorPanel[] {
  return useRegistry(inspectorPanels)
    .list()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
