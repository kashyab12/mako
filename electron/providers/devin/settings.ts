import { spawn } from "node:child_process"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import { environmentForExecutable } from "../../executable.js"
import { acpObservedSettings } from "../../acp-config.js"

/** Devin reports its effective model when opening a session, not in models/list. */
export async function devinDefaultModel(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string | undefined> {
  const child = spawn(executable, ["acp"], {
    cwd,
    env: environmentForExecutable(executable, env),
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr.resume()
  child.once("error", (error) => child.stdout.destroy(error))
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000)
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
  )
  try {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    })
    // Never leave empty discovery sessions in the user's history.
    if (!initialized.agentCapabilities?.sessionCapabilities?.delete)
      throw new Error("Devin does not support cleaning up a settings probe")
    const session = await connection.newSession({ cwd, mcpServers: [] })
    try {
      return acpObservedSettings(session.configOptions ?? []).model
    } finally {
      await connection.deleteSession({ sessionId: session.sessionId })
    }
  } finally {
    clearTimeout(timer)
    child.kill("SIGTERM")
  }
}
