import { CommitPromptSection } from "@/components/settings/commit-prompt-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "commits",
  title: "Commit messages",
  group: "Project",
  keywords: [
    "git",
    "commit",
    "prompt",
    "message",
    "model",
    "API key",
    "Google",
    "Gemini",
    "OpenAI",
    "Anthropic",
    "draft",
    "push",
    "pull request",
  ],
  Component: CommitPromptSection,
} as const satisfies SettingsSection
