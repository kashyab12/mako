import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import { acpObservedSettings } from "../../acp-config.js"
import { withDiscoveryProcess } from "../discovery-process.js"
import { withDevinProbeWorkspace } from "./probe-workspace.js"

/** Devin reports its effective model when opening a session, not in models/list. */
export async function devinDefaultModel(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  // Never leave empty discovery sessions in the user's history.
  return withDevinProbeWorkspace(executable, env, (workspace) =>
    withDiscoveryProcess(
      { command: executable, args: ["acp"], env, cwd },
      async ({ child, phase }) => {
        const connection = new ClientSideConnection(
          () => ({
            sessionUpdate: async () => {},
            requestPermission: async () => ({
              outcome: { outcome: "cancelled" },
            }),
          }),
          ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
        )
        phase("initialize")
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { session: { configOptions: { boolean: {} } } },
        })
        phase("default model discovery")
        const session = await connection.newSession({
          cwd: workspace,
          mcpServers: [],
        })
        const model = acpObservedSettings(session.configOptions ?? []).model
        if (!model) throw new Error("Devin did not report its default model")
        return model
      }
    )
  )
}
