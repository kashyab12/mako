import { useEffect } from "react"
import {
  commands,
  isTypingTarget,
  matchesChord,
  registerCommands,
  type DeskCommand,
} from "@/extend/commands"
import { installBuiltins } from "@/desk/builtins"
import { actions, store } from "@/state/session"
import { getPi } from "@/lib/bridge"
import { prefsStore, setPref, togglePref } from "@/state/prefs"
import { tabsStore } from "@/state/tabs"
import { search } from "@/state/search"
import type { ThinkingLevel } from "@/lib/types"

const openPalette = () => {
  window.dispatchEvent(new CustomEvent("pi:palette"))
}
const focusComposer = () => {
  window.dispatchEvent(new CustomEvent("pi:focus-composer"))
}

/** 1-9 from a keyboard event, or 0 if this was not a digit. */
function digitOf(event: KeyboardEvent): number {
  if (/^[1-9]$/.test(event.key)) return Number(event.key)
  if (/^Digit[1-9]$/.test(event.code)) return Number(event.code.slice(5))
  return 0
}

/** Move `delta` tabs along the strip, wrapping at both ends. */
function stepTab(delta: number) {
  const { tabs, activeId } = tabsStore.get()
  if (tabs.length < 2) return
  const at = tabs.findIndex((tab) => tab.id === activeId)
  const next = tabs[(at + delta + tabs.length) % tabs.length]
  if (next) void actions.switchTab(next.id)
}

/** Advance to the next effort level the current model actually supports. */
function cycleEffort() {
  const meta = store.get().meta
  if (!meta) return
  const levels = meta.thinkingLevels
  if (levels.length <= 1) return
  const index = levels.indexOf(meta.thinkingLevel as ThinkingLevel)
  void actions.setThinking(levels[(index + 1) % levels.length])
}

const DESK_COMMANDS: DeskCommand[] = [
  {
    id: "session.new",
    title: "New session",
    section: "Session",
    keys: "mod+n",
    run: () => void actions.newSession(),
  },
  {
    id: "tab.new",
    title: "New tab",
    section: "Session",
    hint: "Another conversation, running beside this one",
    keys: "mod+t",
    run: () => void actions.openTab(),
  },
  {
    id: "tab.close",
    title: "Close tab",
    section: "Session",
    keys: "mod+w",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => void actions.closeTab(tabsStore.get().activeId),
  },
  {
    id: "tab.next",
    title: "Next tab",
    section: "Session",
    keys: "mod+shift+]",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => stepTab(1),
  },
  {
    id: "tab.previous",
    title: "Previous tab",
    section: "Session",
    keys: "mod+shift+[",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => stepTab(-1),
  },
  {
    id: "session.focus-composer",
    title: "Focus the composer",
    section: "Session",
    keys: "mod+l",
    run: focusComposer,
  },
  {
    id: "session.stop",
    title: "Stop the current turn",
    section: "Session",
    keys: "mod+escape",
    when: () => store.get().meta?.isStreaming ?? false,
    run: () => void actions.abort(),
  },
  {
    id: "session.compact",
    title: "Compact the conversation",
    section: "Session",
    hint: "Summarize history to free context",
    run: () => void actions.compact(),
  },
  {
    id: "session.auto-compact",
    title: "Toggle auto-compaction",
    section: "Session",
    run: () => void actions.setAutoCompaction(!(store.get().meta?.autoCompaction ?? true)),
  },
  {
    id: "workspace.open",
    title: "Open folder…",
    section: "Workspace",
    keys: "mod+o",
    run: () => void actions.pickWorkspace(),
  },
  {
    id: "workspace.generate-commit",
    title: "Draft a commit message",
    section: "Workspace",
    keys: "mod+shift+g",
    hint: "From the staged diff, using the current model",
    run: () => {
      setPref("inspectorOpen", true)
      setPref("inspectorTab", "changes")
    },
  },
  {
    id: "workspace.stage-all",
    title: "Stage every change",
    section: "Workspace",
    run: () => void getPi().gitStageAll(),
  },
  {
    id: "workspace.push",
    title: "Push the current branch",
    section: "Workspace",
    hint: "Publishes work outside this machine",
    run: () => void getPi().gitPush(),
  },
  {
    id: "workspace.refresh-git",
    title: "Refresh git status",
    section: "Workspace",
    run: () => void actions.refreshGit(),
  },
  {
    id: "model.pick",
    title: "Switch model…",
    section: "Model",
    keys: "mod+shift+m",
    hint: "Search every authenticated model",
    run: () => {
      openPalette()
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
        if (input) {
          input.value = ""
          input.focus()
        }
      })
    },
  },
  {
    id: "model.cycle-effort",
    title: "Cycle reasoning effort",
    section: "Model",
    keys: "mod+.",
    run: cycleEffort,
  },
  {
    id: "model.refresh",
    title: "Reload model catalog",
    section: "Model",
    run: () => void actions.refreshModels(),
  },
  {
    id: "view.toggle-rail",
    title: "Toggle the session list",
    section: "View",
    keys: "mod+b",
    run: () => togglePref("railOpen"),
  },
  {
    id: "view.toggle-diff",
    title: "Toggle the diff pane",
    section: "View",
    keys: "mod+shift+d",
    hint: "The changed file's contents, beneath the file list",
    run: () => {
      setPref("inspectorOpen", true)
      setPref("inspectorTab", "changes")
      togglePref("autoOpenDiff")
    },
  },
  {
    id: "view.search",
    title: "Search everything…",
    section: "View",
    keys: "mod+shift+f",
    hint: "File contents and every conversation, in one query",
    run: () => search.open(),
  },
  {
    id: "view.quick-open",
    title: "Open a file…",
    section: "View",
    keys: "mod+p",
    hint: "Find any file in the project by name",
    run: () => window.dispatchEvent(new CustomEvent("pi:quick-open")),
  },
  {
    id: "view.files",
    title: "Show the project files",
    section: "View",
    keys: "mod+shift+e",
    hint: "Browse the folder the agent is working in",
    run: () => {
      setPref("railOpen", true)
      setPref("railMode", "files")
    },
  },
  {
    id: "view.threads",
    title: "Show the thread list",
    section: "View",
    run: () => {
      setPref("railOpen", true)
      setPref("railMode", "threads")
    },
  },
  {
    id: "view.toggle-inspector",
    title: "Toggle the inspector",
    section: "View",
    keys: "mod+i",
    run: () => togglePref("inspectorOpen"),
  },
  {
    id: "view.changes",
    title: "Show changed files",
    section: "View",
    keys: "mod+alt+1",
    run: () => {
      setPref("inspectorOpen", true)
      setPref("inspectorTab", "changes")
    },
  },
  {
    id: "view.context",
    title: "Show context: files, skills, tokens",
    section: "View",
    keys: "mod+alt+2",
    run: () => {
      setPref("inspectorOpen", true)
      setPref("inspectorTab", "context")
    },
  },
  {
    id: "view.history",
    title: "Show history and rewind points",
    section: "View",
    keys: "mod+alt+3",
    run: () => {
      setPref("inspectorOpen", true)
      setPref("inspectorTab", "history")
    },
  },
  {
    id: "view.group-by-project",
    title: "Group sessions by project",
    section: "Workspace",
    run: () =>
      setPref("railGroupBy", prefsStore.get().railGroupBy === "project" ? "date" : "project"),
  },
  {
    id: "view.all-projects",
    title: "Show sessions from every project",
    section: "Workspace",
    hint: "Search and switch across projects",
    run: () => {
      const next = prefsStore.get().railScope === "all" ? "workspace" : "all"
      setPref("railScope", next)
      void actions.refreshSessions(undefined, next)
    },
  },
  {
    id: "view.toggle-thinking",
    title: "Toggle reasoning blocks",
    section: "View",
    run: () => togglePref("showThinking"),
  },
  {
    id: "view.settings",
    title: "Settings",
    section: "View",
    keys: "mod+,",
    run: () => window.dispatchEvent(new CustomEvent("pi:settings")),
  },
  {
    id: "session.improve-mako",
    title: "Improve Mako",
    section: "Session",
    // Hidden in a packaged build, where there is no source tree to point at
    // and no dev server to apply an edit through.
    hint: "Point this session at Mako's own source",
    keywords: "self edit source dogfood hack",
    // Hidden in a packaged build, where there is no source tree to point at
    // and no dev server to apply an edit through.
    when: () => Boolean(store.get().sourceRoot),
    run: async () => {
      const root = store.get().sourceRoot
      if (root) await actions.openWorkspace(root)
    },
  },
  {
    id: "view.toggle-depth",
    title: "Toggle translucency and depth",
    section: "View",
    run: () => togglePref("glass"),
  },
  {
    id: "view.toggle-theme",
    title: "Toggle light and dark",
    section: "View",
    run: () => setPref("theme", prefsStore.get().theme === "light" ? "dark" : "light"),
  },
]

/**
 * Registers the desk's own commands and installs the single global key
 * listener. One listener for every shortcut in the app: adding a command with
 * a `keys` field is all it takes to make the chord live.
 */
export function useDeskCommands() {
  useEffect(() => {
    const disposers = [registerCommands(DESK_COMMANDS), installBuiltins()]
    return () => disposers.forEach((dispose) => dispose())
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openPalette()
        return
      }

      // ⌘1…⌘9 jumps straight to a tab — the one shortcut every tabbed app
      // agrees on. Bound here rather than as nine palette commands nobody
      // would ever search for. Both `key` and `code` are consulted: `code` is
      // layout-independent, `key` is what synthetic events actually carry.
      const digit = digitOf(event)
      if (mod && !event.shiftKey && !event.altKey && digit > 0) {
        const tabs = tabsStore.get().tabs
        const target = tabs[digit - 1]
        if (tabs.length > 1 && target) {
          event.preventDefault()
          void actions.switchTab(target.id)
          return
        }
      }

      // Unmodified keys belong to whatever the user is typing into.
      if (!mod && !event.altKey && isTypingTarget(event.target)) return

      for (const command of commands.list()) {
        if (!command.keys || !matchesChord(event, command.keys)) continue
        if (command.when?.() === false) continue
        event.preventDefault()
        void command.run()
        return
      }
    }

    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
