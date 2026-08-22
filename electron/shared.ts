/**
 * Compatibility barrel for the Electron/renderer wire contract.
 *
 * Keep existing consumers importing this module while domain contracts live
 * under `electron/contracts/`.
 */
export * from "./contracts/automations-usage-updates.js"
export * from "./contracts/conversation-session.js"
export * from "./contracts/git-workspace-search.js"
export * from "./contracts/host-events-boot.js"
export * from "./contracts/mcp-skills-integrations.js"
export * from "./contracts/providers-acp.js"
export * from "./contracts/terminal.js"
