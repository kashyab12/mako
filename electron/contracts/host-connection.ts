/**
 * One wording for "the shared host went away mid-call".
 *
 * The host says it when it closes with requests still pending, the client says
 * it when the socket drops under a call, and the renderer matches on it so a
 * refresh that failed for this reason rides the reconnect banner instead of
 * raising a second alarm. Kept free of imports so both sides can share it.
 */
/** The host closed with this call already dispatched; its outcome is unknown. */
export const HOST_RESTARTING_CODE = "host-restarting"
/** The call reached a host that had already begun closing; nothing ran. */
export const HOST_CLOSED_CODE = "host-closed"
export const HOST_RECONNECTING_MESSAGE =
  "Mako's shared host is restarting. This window reconnects on its own."
export const HOST_CALL_UNCONFIRMED_MESSAGE = `${HOST_RECONNECTING_MESSAGE} The last action was not confirmed; check its result before repeating it.`

export function isHostReconnectingError(error: Error): boolean {
  return error.message.includes(HOST_RECONNECTING_MESSAGE)
}
