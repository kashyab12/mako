import type { NextConfig } from "next"
import { withEve } from "eve/next"

const config: NextConfig = {
  outputFileTracingIncludes: {
    "/api/mcp": ["./agent/skills/**/*"],
  },
  poweredByHeader: false,
}

export default withEve(config)
