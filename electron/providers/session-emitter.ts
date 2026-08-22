import type { EmitResult, Thread } from "@mako/sessions"
import type { ProviderCapability } from "./registry.js"

export interface ProviderSessionEmitter extends ProviderCapability {
  emit(thread: Thread): Promise<EmitResult>
}
