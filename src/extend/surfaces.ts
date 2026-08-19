import type { ComponentType } from "react"
import { Registry, useRegistry } from "@/extend/registry"
import type { NoProps } from "@/extend/slots"

/**
 * Surfaces are the stage's registry: every view of the current thread that
 * can open with the chat — beside it for reading, or below it for a terminal.
 * The chat itself is structural and never registered,
 * the same way the composer is not a plugin. Everything else, including all
 * of the desk's own panels, arrives through this one call, so a plugin's
 * surface is indistinguishable from a built-in one.
 */
export interface SurfaceDefinition {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
  render: ComponentType<NoProps>
  order?: number
  placement?: "side" | "bottom"
  minHeight?: number
  /**
   * The narrowest this surface is useful beside the chat. The stage never
   * splits by percentage: the companion keeps its minimum and the chat takes
   * the rest, so a wide monitor grows the conversation, not the sidebar.
   */
  minWidth?: number
}

export const surfaces = new Registry<SurfaceDefinition>()

export function registerSurface(surface: SurfaceDefinition): () => void {
  return surfaces.register(surface.id, surface)
}

export function useSurfaces(): SurfaceDefinition[] {
  return useRegistry(surfaces)
    .list()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
