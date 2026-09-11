import type { LiveSteering } from "@/lib/types"

/** What sending into the running turn does, in the provider's own terms. */
export function steeringTitle(kind: LiveSteering | null): string {
  switch (kind) {
    case "interrupt":
      return "Interrupt the current step and continue with this message"
    case "step":
      return "Send into the running turn at its next step"
    default:
      return "Send into the running turn"
  }
}

export function steeringSummary(kind: LiveSteering | null): string {
  switch (kind) {
    case "interrupt":
      return "This agent stops its current step, keeps what it did, and continues with your message."
    case "step":
      return "This agent reads your message at its next step and keeps working."
    default:
      return "Messages wait until the agent finishes its turn."
  }
}
