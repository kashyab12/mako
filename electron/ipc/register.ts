import { ipcMain } from "electron"
import { breadcrumb, record } from "../crash.js"

/**
 * Every IPC call, wrapped once.
 *
 * Two things fall out of doing this in one place rather than at forty call
 * sites: a breadcrumb per call, so a crash report says what the app was doing;
 * and a recorded report for any handler that throws, which until now surfaced
 * only as a toast and left nothing behind to read afterwards.
 *
 * The breadcrumb is the channel name and nothing else. Arguments would mean
 * keeping the user's prompts and source on disk, which the crash file promises
 * not to do.
 */
export function registerIpc(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    breadcrumb(channel)
    try {
      return await listener(event, ...args)
    } catch (error) {
      record("main-uncaught", error, channel)
      throw error
    }
  })
}
