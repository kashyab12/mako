import type {
  HarnessModel as SharedHarnessModel,
  HarnessProfile as SharedHarnessProfile,
} from "../../electron/shared.ts"

export type {
  AcpPermissionRequest,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  EntryBlock,
  Harness,
  Thread,
  ThreadEntry,
  ThreadRef,
  ThreadRunState,
  TurnUsage,
  Automation,
  AutomationRun,
  Block,
  BlockType,
  BootPayload,
  Capabilities,
  ChatRole,
  CommandSummary,
  ContextUsage,
  DevServerState,
  FileContents,
  GitCommitEntry,
  GitDiff,
  GitFile,
  GitFileStatus,
  GitStatus,
  ListeningPort,
  GitHubStatus,
  CheckSummary,
  PullRequest,
  ReviewSummary,
  HostEvent,
  HarnessModel,
  HarnessModelOption,
  HarnessModelVariant,
  HarnessProfile,
  HarnessSelectValue,
  ModelCost,
  ModelInfo,
  McpProvider,
  McpRegistryProviderStatus,
  McpRegistrySnapshot,
  McpScope,
  McpServerDefinition,
  McpServerOrigin,
  McpServerRecord,
  McpSyncPreview,
  McpSyncTarget,
  McpTransport,
  FileMatches,
  SearchOptions,
  SearchResults,
  ThreadMatches,
  ChatMessage,
  SessionMeta,
  SessionState,
  SessionSummary,
  SkillSummary,
  StagedFile,
  TabSnapshot,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalSession,
  TerminalSessionStatus,
  TerminalSnapshot,
  ThinkingLevel,
  UpdateState,
  UsageSummary,
  UsageTotals,
  TokenStats,
  ToolSummary,
  TreeNode,
  WorkspaceFile,
} from "../../electron/shared.ts"

export { THINKING_LEVELS } from "../../electron/shared.ts"

export function harnessModelByIdentity(
  profile: SharedHarnessProfile | undefined,
  identity: string | undefined
): SharedHarnessModel | undefined {
  if (!profile || !identity) return undefined
  return profile.models.find(
    (model) =>
      model.id === identity ||
      model.launchId === identity ||
      model.aliases?.includes(identity)
  )
}
