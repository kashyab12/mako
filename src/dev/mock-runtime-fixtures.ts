import type { Capabilities, TerminalSession } from "@/lib/types"
import { META } from "./mock-fixtures"

export function createCapabilities(): Capabilities {
  return {
    tools: [
      { name: "read", description: "Read a file from disk", active: true },
      {
        name: "edit",
        description: "Replace exact text in a file",
        active: true,
      },
      {
        name: "write",
        description: "Create or overwrite a file",
        active: true,
      },
      {
        name: "bash",
        description: "Run a shell command in the workspace",
        active: true,
      },
      {
        name: "grep",
        description: "Search file contents by regex",
        active: true,
      },
      { name: "find", description: "Find files by glob pattern", active: true },
      { name: "ls", description: "List a directory", active: false },
    ],
    commands: [
      { name: "compact", description: "Summarize history to free context" },
      { name: "model", description: "Switch the active model" },
      { name: "cost", description: "Show token spend for this session" },
      { name: "export", description: "Write this session to HTML" },
      {
        name: "tree",
        description: "Jump to another point in the session tree",
      },
    ],
    skills: [
      {
        name: "review-diff",
        description:
          "Read the working tree and report defects with severities.",
      },
      {
        name: "write-tests",
        description:
          "Generate tests for changed code paths, matching the repo's style.",
      },
    ],
  }
}

export function initialTerminalSessions(): TerminalSession[] {
  return [
    {
      id: "mock-terminal-1",
      title: "mako",
      cwd: META.cwd,
      createdAt: Date.now() - 240_000,
      updatedAt: Date.now(),
      status: "running",
      cols: 80,
      rows: 24,
      sequence: 1,
    },
  ]
}

export function mockThreads() {
  return {
    ready: true,
    threads: [
      {
        harness: "codex" as const,
        nativeId: "cx-1",
        path: "/mock/codex.jsonl",
        cwd: "/Users/you/api",
        title: "Trace the flaky webhook retry",
        model: "gpt-5.2-codex",
        updatedAt: new Date(Date.now() - 1_200_000).toISOString(),
        startedAt: new Date(Date.now() - 5_200_000).toISOString(),
        bytes: 20_000,
      },
      {
        harness: "claude" as const,
        nativeId: "cl-1",
        path: "/mock/claude.jsonl",
        cwd: "/Users/you/mako",
        title: "Refactor the composer focus handling",
        model: "claude-opus-5",
        updatedAt: new Date(Date.now() - 4_800_000).toISOString(),
        startedAt: new Date(Date.now() - 9_800_000).toISOString(),
        bytes: 48_000,
      },
      ...Array.from({ length: 13 }, (_, i) => ({
        harness: "grok" as const,
        nativeId: `gk-${i}`,
        path: `/mock/grok-${i}.jsonl`,
        cwd: "/Users/you/api",
        title: `Grok sweep #${i + 1}: tighten the retry budget`,
        model: "grok-4.6",
        updatedAt: new Date(Date.now() - (i + 3) * 3_600_000).toISOString(),
        startedAt: new Date(Date.now() - (i + 4) * 3_600_000).toISOString(),
        bytes: 4_000,
      })),
      {
        harness: "devin" as const,
        nativeId: "dv-1",
        path: "/mock/devin.jsonl",
        cwd: "/Users/you/api",
        title: "Wire the payments retry queue",
        model: "adaptive",
        modelProvider: "devin",
        updatedAt: new Date(Date.now() - 2_400_000).toISOString(),
        startedAt: new Date(Date.now() - 6_000_000).toISOString(),
        bytes: 14_000,
        locked: true,
      },
      {
        harness: "cursor" as const,
        nativeId: "cu-1",
        path: "/mock/cursor.db",
        cwd: "/Users/you/site",
        title: "Make the pricing table responsive",
        updatedAt: new Date(Date.now() - 86_000_000).toISOString(),
        startedAt: new Date(Date.now() - 90_000_000).toISOString(),
        bytes: 12_000,
      },
      {
        harness: "claude" as const,
        nativeId: "cl-2",
        path: "/mock/claude-2.jsonl",
        cwd: "/Users/you/api",
        title: "Ship the billing webhooks",
        model: "claude-opus-5",
        updatedAt: new Date(Date.now() - 600_000).toISOString(),
        startedAt: new Date(Date.now() - 2_000_000).toISOString(),
        bytes: 9_000,
        lineage: [{ harness: "devin" as const, title: "Ship the billing webhooks" }],
      },
    ],
  }
}
