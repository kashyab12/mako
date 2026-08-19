import { UpdatesSection } from "@/components/settings/updates-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "updates",
  title: "Updates",
  group: "Application",
  keywords: [
    "version",
    "install",
    "download",
    "release",
    "notes",
    "check",
    "restart",
  ],
  Component: UpdatesSection,
} as const satisfies SettingsSection
