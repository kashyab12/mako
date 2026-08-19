import { useEffect } from "react"
import { Avatar } from "@/components/ui/avatar"
import { Keys, Meter } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { github, useGitHub } from "@/state/github"
import { accounts, useAccounts, usageKey } from "@/state/accounts"
import { cn } from "@/lib/utils"
import { CheckIcon, CopyIcon, SettingsIcon } from "lucide-react"

/**
 * Who the desk is working as: the GitHub identity on top, then every
 * provider account with its usage windows — the bar near full is the reason
 * to switch, so the switch lives here, one click from anywhere.
 *
 * Three states, none of them hidden: no GitHub yet shows how to connect
 * (the capability must be discoverable exactly by the people who have not
 * set it up), connected shows the accounts, loading shimmers.
 */
export function IdentityMenu() {
  const status = useGitHub((state) => state.status)
  const avatar = useGitHub((state) => state.userAvatar)
  const list = useAccounts((state) => state.accounts)
  const usage = useAccounts((state) => state.usage)
  const busy = useAccounts((state) => state.busy)

  useEffect(() => {
    void github.ensureStatus()
    accounts.load()
  }, [])

  const connected = Boolean(status?.installed && status?.authenticated)

  return (
    <div className="flex w-72 flex-col">
      {connected && status?.login ? (
        <div className="flex items-center gap-2.5 px-1 pt-0.5 pb-2">
          <Avatar src={avatar} name={status.login} size={8} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui font-medium text-foreground">{status.login}</p>
            <p className="truncate text-label text-faint">
              {status.repo ? `GitHub · ${status.repo}` : "GitHub"}
            </p>
          </div>
        </div>
      ) : (
        <div className="px-1 pt-0.5 pb-2">
          <p className="text-ui font-medium text-foreground">Connect GitHub</p>
          <p className="pt-0.5 text-label leading-relaxed text-faint">
            Mako reuses the gh CLI's login for pull requests and identity.
          </p>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText("gh auth login")}
            className="pressable mt-1.5 flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 font-mono text-label text-muted-foreground hover:text-foreground"
          >
            gh auth login
            <CopyIcon className="size-3" />
          </button>
        </div>
      )}

      {list.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-hairline pt-1.5">
          {list.map((account) => {
            const key = usageKey(account.harness, account.name)
            const stats = usage[key]
            const identity = account.email ?? account.name
            return (
              <button
                key={key}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void accounts.select(account.harness, account.name)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100",
                  account.active ? "bg-fill-selected" : "hover:bg-fill-hover",
                  busy && "opacity-60"
                )}
              >
                <Avatar name={identity} size={5} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-foreground/90">{identity}</span>
                  <span className="flex items-center gap-2 text-label text-faint">
                    {account.harness === "claude" ? "Claude Code" : "Codex"}
                    {stats?.status === "ok" ? (
                      <>
                        {stats.session ? (
                          <span className="flex items-center gap-1">
                            5h
                            <Meter
                              value={stats.session.usedPercent / 100}
                              tone={stats.session.usedPercent > 90 ? "negative" : stats.session.usedPercent > 72 ? "caution" : "neutral"}
                              className="w-8"
                            />
                          </span>
                        ) : null}
                        {stats.weekly ? (
                          <span className="flex items-center gap-1">
                            wk
                            <Meter
                              value={stats.weekly.usedPercent / 100}
                              tone={stats.weekly.usedPercent > 90 ? "negative" : stats.weekly.usedPercent > 72 ? "caution" : "neutral"}
                              className="w-8"
                            />
                          </span>
                        ) : null}
                        {stats.plan ? <span>{stats.plan}</span> : null}
                      </>
                    ) : null}
                  </span>
                </span>
                {account.active ? (
                  <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                ) : busy === key ? (
                  <span className="shimmer shrink-0 text-label">…</span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="mt-1.5 border-t border-hairline pt-1.5">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
          }
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        >
          <SettingsIcon className="size-3.5" />
          <span className="flex-1">Accounts and settings</span>
          <Keys keys={formatChord("mod+,")} />
        </button>
      </div>
    </div>
  )
}
