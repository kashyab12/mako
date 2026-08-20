import { defineTool } from "eve/tools"
import { z } from "zod"
import { readOptionalServerEnv } from "../../src/config/env"
import { backendStatus } from "../../src/status"

export default defineTool({
  description:
    "Read Mako backend health, MCP readiness, and integration connection state without credentials.",
  inputSchema: z.object({}),
  execute() {
    return backendStatus(readOptionalServerEnv())
  },
})
