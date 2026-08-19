import { useEffect } from "react"
import {
  commands,
  isTypingTarget,
  keysFor,
  matchesChord,
  registerCommands,
  type DeskCommand,
} from "@/extend/commands"
import { installBuiltins } from "@/desk/builtins"
import { actions, store } from "@/state/session"
import { getMako } from "@/lib/bridge"
import { prefsStore, setPref, togglePref } from "@/state/prefs"
import { stage } from "@/state/stage"
import { surfaces } from "@/extend/surfaces"
import { tabsStore } from "@/state/tabs"
import { search } from "@/state/search"

const openPalette = () => {
  window.dispatchEvent(new CustomEvent("mako:palette"))
}
const focusComposer = () => {
  window.dispatchEvent(new CustomEvent("mako:focus-composer"))
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
  const index = levels.indexOf(meta.thinkingLevel)
  void actions.setThinking(levels[(index + 1) % levels.length])
}

const DESK_COMMANDS: DeskCommand[] = [
  {
    id: "view.command-palette",
    title: "Open command palette",
    section: "View",
    keys: "mod+k",
    run: openPalette,
  },
  {
    id: "session.new",
    title: "New session",
    section: "Session",
    keys: "mod+n",
    run: () => void actions.newSession(),
  },
  {
    id: "tab.new",
    title: "Attach another session",
    section: "Session",
    hint: "A second conversation kept running beside this one",
    keys: "mod+t",
    run: () => void actions.openTab(),
  },
  {
    id: "tab.close",
    title: "Detach this session",
    section: "Session",
    hint: "It stays in the rail; it just stops being held open",
    keys: "mod+w",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => void actions.closeTab(tabsStore.get().activeId),
  },
  {
    id: "tab.next",
    title: "Next attached session",
    section: "Session",
    keys: "mod+shift+]",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => stepTab(1),
  },
  {
    id: "tab.previous",
    title: "Previous attached session",
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
      stage.open("changes")
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("mako:draft-commit"))
      )
    },
  },
  {
    id: "workspace.stage-all",
    title: "Stage every change",
    section: "Workspace",
    run: () => void getMako().gitStageAll(),
  },
  {
    id: "workspace.push",
    title: "Push the current branch",
    section: "Workspace",
    hint: "Publishes work outside this machine",
    run: () => void getMako().gitPush(),
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
    id: "view.preview",
    title: "Toggle the preview",
    section: "View",
    keys: "mod+shift+p",
    hint: "The dev server, beside the conversation",
    run: () => stage.toggle("preview"),
  },
  {
    id: "view.toggle-diff",
    title: "Toggle the diff pane",
    section: "View",
    keys: "mod+shift+d",
    hint: "The changed file's contents, beneath the file list",
    run: () => {
      stage.open("changes")
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
    run: () => window.dispatchEvent(new CustomEvent("mako:quick-open")),
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
    id: "view.toggle-companion",
    title: "Toggle the companion pane",
    section: "View",
    keys: "mod+i",
    hint: "Hide what is open beside the chat, or bring back the last one",
    run: () => stage.toggleCompanion(),
  },
  {
    id: "view.changes",
    title: "Show changed files",
    section: "View",
    run: () => stage.toggle("changes"),
  },
  {
    id: "view.context",
    title: "Show context: files, skills, tokens",
    section: "View",
    run: () => stage.toggle("context"),
  },
  {
    id: "view.history",
    title: "Show history and rewind points",
    section: "View",
    run: () => stage.toggle("history"),
  },
  {
    id: "view.terminal",
    title: "Show terminal",
    section: "View",
    run: () => stage.toggle("terminal"),
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
    id: "view.guide",
    title: "What is where",
    section: "View",
    keys: "mod+/",
    hint: "The layout, and every key that does something",
    run: () => window.dispatchEvent(new CustomEvent("mako:guide")),
  },
  {
    id: "view.settings",
    title: "Settings",
    section: "View",
    keys: "mod+,",
    run: () => window.dispatchEvent(new CustomEvent("mako:settings")),
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
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return
      }
      const mod = event.metaKey || event.ctrlKey

      // ⌘1 shows the chat; ⌘2…⌘9 toggle the surfaces in strip order. Bound
      // here rather than as nine palette commands nobody would search for.
      // Both `key` and `code` are consulted: `code` is layout-independent,
      // `key` is what synthetic events actually carry. Attached sessions
      // cycle with ⌘⇧[ and ⌘⇧] instead.
      const digit = digitOf(event)
      if (mod && !event.shiftKey && !event.altKey && digit > 0) {
        event.preventDefault()
        if (digit === 1) {
          stage.showChat()
          stage.close()
        } else {
          const target = surfaces.list().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[digit - 2]
          if (target) stage.toggle(target.id)
        }
        return
      }

      // Unmodified keys belong to whatever the user is typing into.
      if (!mod && !event.altKey && isTypingTarget(event.target)) return

      const overrides = prefsStore.get().keybindings
      for (const command of commands.list()) {
        const keys = keysFor(command, overrides)
        if (!keys || !matchesChord(event, keys)) continue
        if (command.when?.() === false) continue
        event.preventDefault()
        void command.run()
        return
      }
    }

    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
}
