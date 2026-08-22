import type { ProviderCapability } from "./registry.js"

export interface SkillAccountLocation {
  name: string
  dir?: string
}

export interface ProviderSkillSource extends ProviderCapability {
  command(): string | null
  userRoots(account: SkillAccountLocation): string[]
  workspaceFolder: string
  targetUserRoot(account: SkillAccountLocation): string
}
