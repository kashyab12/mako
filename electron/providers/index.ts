import { installClaude } from "./claude/index.js"
import { installCodex } from "./codex/index.js"
import { installCursor } from "./cursor/index.js"
import { installDevin } from "./devin/index.js"
import { installGrok } from "./grok/index.js"
import { createProviderHost, type ProviderModule } from "./host.js"
import { installOpenCode } from "./opencode/index.js"

const modules: ProviderModule[] = [
  installClaude,
  installCodex,
  installCursor,
  installGrok,
  installDevin,
  installOpenCode,
]

export const providerHost = createProviderHost()
for (const install of modules) install(providerHost)
