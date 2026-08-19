import { useEffect, useState } from "react"
import { Action, Eyebrow } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import type { McpSyncTarget } from "@/lib/types"
import { mcp, useMcp } from "@/state/mcp"
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react"

export function McpSection() {
  const state = useMcp((value) => value)
  const [targets, setTargets] = useState<McpSyncTarget[]>([])
  const [scope, setScope] = useState<"user" | "workspace">("user")

  useEffect(() => {
    void mcp.load()
  }, [])

  const snapshot = state.snapshot
  const orderedServers = snapshot
    ? [
        ...snapshot.servers.filter((server) => !server.managed),
        ...snapshot.servers.filter((server) => server.managed),
      ]
    : []
  const toggleTarget = (target: McpSyncTarget) => {
    setTargets((current) =>
      current.some((candidate) => sameTarget(candidate, target))
        ? current.filter((candidate) => !sameTarget(candidate, target))
        : [...current, target]
    )
  }

  return (
    <div>
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Servers found in each provider&apos;s configuration, deduplicated by
        connection. Mako-managed Browser Use and computer use attach only to
        sessions launched here; they are never written into provider clients.
        Environment and header values stay in the host.
      </p>

      {state.permissions?.supported ? (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-surface px-2.5 py-2 ring-1 ring-hairline">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-foreground/90">
              Computer use runs as Mako
            </span>
            <span className="block text-label text-faint">
              {state.permissions.accessibility &&
              state.permissions.screenRecording === "granted"
                ? "Accessibility and Screen Recording are granted once to Mako."
                : "Grant Accessibility and Screen Recording once; macOS Harness and the embedded CUA fallback share Mako’s app identity."}
            </span>
          </span>
          {!state.permissions.accessibility ||
          state.permissions.screenRecording !== "granted" ? (
            <Action
              tone="outline"
              onClick={() => void mcp.requestComputerPermissions()}
            >
              Grant to Mako
            </Action>
          ) : null}
        </div>
      ) : null}

      {state.status === "loading" && !snapshot ? (
        <p className="shimmer text-ui text-faint">
          Reading provider configurations…
        </p>
      ) : null}

      {snapshot ? (
        <>
          <div className="flex items-center justify-between pt-2 pb-1">
            <Eyebrow className="px-0">Sync to</Eyebrow>
            <span className="flex rounded-md bg-raised p-0.5 text-label">
              {(["user", "workspace"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setScope(value)
                    setTargets([])
                  }}
                  className={cn(
                    "pressable rounded px-1.5 py-0.5",
                    scope === value
                      ? "bg-surface text-foreground"
                      : "text-faint hover:text-foreground"
                  )}
                >
                  {value === "user" ? "All projects" : "This project"}
                </button>
              ))}
            </span>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {snapshot.providers.map((provider) => {
              const target: McpSyncTarget = {
                provider: provider.id,
                account: provider.account,
                scope,
              }
              const selected = targets.some((candidate) =>
                sameTarget(candidate, target)
              )
              return (
                <label
                  key={`${provider.id}:${provider.account}`}
                  className={cn(
                    "flex items-center gap-2 rounded-md bg-surface px-2.5 py-2 text-ui ring-1 ring-hairline",
                    provider.available ? "cursor-pointer" : "opacity-50"
                  )}
                  title={provider.detail ?? provider.source}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!provider.available}
                    onChange={() => toggleTarget(target)}
                    className="size-3 accent-current"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {provider.label}
                  </span>
                  <span className="text-label text-faint">
                    {provider.available ? provider.account : "not found"}
                  </span>
                </label>
              )
            })}
          </div>

          <Eyebrow className="px-0 pb-1">Definitions</Eyebrow>
          <div className="flex flex-col rounded-lg bg-surface ring-1 ring-hairline">
            {orderedServers.map((server) => {
              const previews = state.previews[server.id] ?? []
              const previewsCurrent =
                previews.length === targets.length &&
                previews.every((preview) =>
                  targets.some((target) => sameTarget(preview.target, target))
                )
              const actionable = previewsCurrent
                ? previews.filter(
                    (preview) =>
                      preview.action === "add" || preview.action === "replace"
                  )
                : []
              const disabled =
                server.managed ||
                !server.portable ||
                server.availability === "unavailable" ||
                Boolean(server.conflict)
              return (
                <div
                  key={server.id}
                  className={cn(
                    "flex gap-2.5 border-b border-hairline px-2.5 py-2.5 last:border-b-0",
                    disabled && "opacity-60"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-ui">
                        {server.name}
                      </span>
                      <span className="rounded bg-raised px-1 py-0.5 text-label text-faint">
                        {server.transport}
                      </span>
                      {server.managed ? (
                        <span className="text-label text-faint">
                          Mako sessions only
                        </span>
                      ) : null}
                      {server.conflict ? (
                        <span className="flex items-center gap-1 text-label text-caution">
                          <AlertTriangleIcon className="size-3" /> conflicting
                          definitions
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-label text-faint">
                      {definitionPreview(server)}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-2 text-label text-faint">
                      {server.origins.map((origin) => (
                        <span
                          key={`${origin.provider}:${origin.account}:${origin.provenance}`}
                        >
                          {origin.provider === "mako"
                            ? "Mako managed"
                            : origin.provider}
                        </span>
                      ))}
                      {server.envNames.length ? (
                        <span>env {server.envNames.join(", ")}</span>
                      ) : null}
                      {server.headerNames.length ? (
                        <span>headers {server.headerNames.join(", ")}</span>
                      ) : null}
                      {server.blockReason ? (
                        <span>{server.blockReason}</span>
                      ) : null}
                      {server.detail ? <span>{server.detail}</span> : null}
                    </span>
                    {previewsCurrent && previews.length ? (
                      <span className="mt-1.5 block text-label text-muted-foreground">
                        {previews.map((preview) => preview.summary).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-start gap-1.5">
                    <Action
                      tone="outline"
                      disabled={
                        disabled ||
                        targets.length === 0 ||
                        state.status === "syncing"
                      }
                      onClick={() => void mcp.preview(server.id, targets)}
                    >
                      Preview
                    </Action>
                    {actionable.length ? (
                      <Action
                        disabled={state.status === "syncing"}
                        onClick={() => void mcp.apply(server.id)}
                      >
                        Apply {actionable.length}{" "}
                        {actionable.length === 1 ? "change" : "changes"}
                      </Action>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="flex items-center gap-2 pt-3">
            <Action
              tone="outline"
              disabled={state.status === "loading"}
              onClick={() => void mcp.load()}
            >
              <RefreshCwIcon className="size-3" />
              Refresh
            </Action>
            <span className="text-label text-faint">
              Preview is required before a write. Sync adds or replaces; it
              never removes.
            </span>
          </div>
        </>
      ) : null}

      {state.error ? (
        <p className="pt-2 text-label text-removed">{state.error}</p>
      ) : null}
    </div>
  )
}

function sameTarget(left: McpSyncTarget, right: McpSyncTarget): boolean {
  return (
    left.provider === right.provider &&
    left.account === right.account &&
    left.scope === right.scope
  )
}

function definitionPreview(server: {
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  url?: string
}): string {
  return server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : (server.url ?? server.transport)
}
