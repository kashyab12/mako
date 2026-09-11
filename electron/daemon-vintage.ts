import { PROTOCOL_VERSION, type DaemonStats } from "@mako/sessions"

/**
 * Whether the daemon answering the socket is one this build should keep using.
 *
 * A different protocol or a different entry script means another vintage: an
 * older install, or a checkout whose files keep changing under the running
 * process. The installed app replaces those; a checkout only steps aside.
 */
export function daemonIsForeign(
  stats: Pick<DaemonStats, "version" | "script">,
  script: string
): boolean {
  if (stats.version !== PROTOCOL_VERSION) return true
  return stats.script !== undefined && stats.script !== script
}
