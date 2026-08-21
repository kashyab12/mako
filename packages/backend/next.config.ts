import type { NextConfig } from "next"

const config: NextConfig = {
  outputFileTracingIncludes: {
    "/api/mcp": ["./skills/**/*"],
  },
  poweredByHeader: false,
}

export default config
