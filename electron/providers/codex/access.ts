import {
  accessModeId,
  accessTierInfo,
  accessTierOfModeId,
  type AccessTier,
} from "../../contracts/access.js"
import type { LiveSessionMode } from "../../shared.js"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js"

/**
 * Codex has no session mode; its approval policy, sandbox, and reviewer are
 * overridden per turn/start and stay in force for later turns. The four tiers
 * below are the pairings Codex itself documents for its own presets.
 */
export const CODEX_ACCESS_TIERS: readonly AccessTier[] = ["ask", "edits", "auto", "full"]

export function codexAccessModes(): LiveSessionMode[] {
  return CODEX_ACCESS_TIERS.map((tier) => {
    const info = accessTierInfo(tier)
    return {
      id: accessModeId(tier),
      name: info.label,
      description: info.summary,
      access: tier,
      enforcement: "provider" as const,
    }
  })
}

export function codexAccessTier(modeId: string): AccessTier {
  const tier = accessTierOfModeId(modeId)
  if (!tier || !CODEX_ACCESS_TIERS.includes(tier))
    throw new Error("Codex does not offer that access level")
  return tier
}

export type CodexTurnAccess = Pick<
  TurnStartParams,
  "approvalPolicy" | "sandboxPolicy" | "approvalsReviewer"
>

/** Applied to every turn/start once a tier is chosen; Codex keeps it for later turns. */
export function codexTurnAccess(tier: AccessTier | null): CodexTurnAccess {
  const workspaceWrite = {
    type: "workspaceWrite" as const,
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
  switch (tier) {
    case "ask":
      return {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        approvalsReviewer: "user",
      }
    case "edits":
      return { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" }
    case "auto":
      return { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite, approvalsReviewer: "auto_review" }
    case "full":
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" }
    default:
      return {}
  }
}
