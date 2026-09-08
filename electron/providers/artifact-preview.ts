import type { ProviderCapability } from "./registry.js"

/** Builds a read-only document for an opaque-origin iframe; never runs artifact code in the host. */
export interface ProviderArtifactPreview extends ProviderCapability {
  matches(path: string): boolean
  render(source: string): Promise<string>
}
