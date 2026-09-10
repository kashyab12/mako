import { registerIpc } from "./register.js"
import type { ThreadArchives } from "../thread-archives.js"
import type { ThreadLifecycle } from "../thread-lifecycle.js"
import type { ArchiveCommand, StopTarget, ThreadTarget } from "../contracts/thread-lifecycle.js"
import type { HostEvent } from "../shared.js"

export function installThreadLifecycleIpc(lifecycle: ThreadLifecycle, archives: ThreadArchives, emit: (event: HostEvent) => void) {
  registerIpc("mako:thread-archives", () => archives.snapshot())
  registerIpc("mako:thread-controls", (_event, target: ThreadTarget) => lifecycle.controls(target))
  registerIpc("mako:thread-archive", (_event, command: ArchiveCommand) => {
    const snapshot = lifecycle.archive(command)
    emit({ type: "thread-archives", snapshot })
    return snapshot
  })
  registerIpc("mako:thread-stop", (_event, target: StopTarget) => lifecycle.stop(target))
}
