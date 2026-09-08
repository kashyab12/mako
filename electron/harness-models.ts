import {
  modelByIdentity,
  resolveModelLaunch,
  type SessionSettings,
} from "@mako/sessions/settings"
import type { HarnessProfile } from "./shared.js"

export function canonicalHarnessModelId(
  profile: HarnessProfile,
  identity: string | undefined
): string | undefined {
  return modelByIdentity(profile.models, identity)?.id
}

export function resolveHarnessTuning(
  profile: HarnessProfile,
  tuning: SessionSettings | undefined
): SessionSettings | undefined {
  return tuning ? resolveModelLaunch(profile.models, tuning) : undefined
}
