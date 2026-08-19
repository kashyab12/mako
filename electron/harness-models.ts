import type {
  HarnessModel,
  HarnessModelOption,
  HarnessModelVariant,
  HarnessProfile,
  HarnessSelectValue,
} from "./shared.js"

const REASONING_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]

export interface ClaudeModelRow {
  value?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsFastMode?: boolean
}

export interface CodexReasoningEffort {
  reasoningEffort?: string
}

export interface CodexServiceTier {
  id?: string
  name?: string
  description?: string
}

export interface CodexModelRow {
  model?: string
  displayName?: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: CodexReasoningEffort[]
  defaultServiceTier?: string
  serviceTiers?: CodexServiceTier[]
}

export interface CodexModelListResponse {
  data?: CodexModelRow[]
}

export interface AcpOptionValueInput {
  value?: string
  name?: string
  description?: string | null
}

export interface AcpOptionGroupInput {
  group?: string
  name?: string
  options: AcpOptionValueInput[]
}

export type AcpOptionEntryInput = AcpOptionValueInput | AcpOptionGroupInput

export interface AcpOptionGroups {
  [group: string]: AcpOptionEntryInput[]
}

export interface AcpConfigOptionInput {
  id?: string
  name?: string
  type?: string
  currentValue?: string | boolean
  options?: AcpOptionEntryInput[] | AcpOptionGroups
}

export interface CursorModelRow {
  value?: string
  name?: string
  configOptions?: AcpConfigOptionInput[]
}

export interface CursorModelListResponse {
  models?: CursorModelRow[]
}

export interface CursorConfig {
  model?: { modelId?: string }
}

export interface GrokReasoningEffort {
  value?: string
  label?: string
  description?: string
  default?: boolean
}

export interface GrokModelInfo {
  name?: string
  description?: string | null
  context_window?: number | null
  max_completion_tokens?: number | null
  reasoning_effort?: string
  reasoning_efforts?: GrokReasoningEffort[]
}

export interface GrokCachedModel {
  info?: GrokModelInfo
}

export interface GrokModelMap {
  [id: string]: GrokCachedModel
}

export interface GrokModelCache {
  models?: GrokModelMap
}

export interface DevinVariantRow {
  model_uid?: string
  label?: string
  description?: string | null
  max_context_tokens?: number
  max_output_tokens?: number
  is_default?: boolean
}

export interface DevinFamilyRow {
  family_label?: string
  slug?: string
  aliases?: string[]
  variants?: DevinVariantRow[]
  is_default?: boolean
}

export interface DevinModelListResponse {
  families?: DevinFamilyRow[]
  default_model?: string
  defaultModel?: string
}

export interface HarnessTuning {
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
}

export interface HarnessModelCatalog {
  models: HarnessModel[]
  defaultModel?: string
  configuredModel?: string
}

export function availableHarnessProfile(
  harness: string,
  catalog: HarnessModelCatalog
): HarnessProfile {
  const metadata = harnessMetadata(harness)
  const profile: HarnessProfile = {
    id: harness,
    label: metadata.label,
    available: true,
    transport: metadata.transport,
    models: catalog.models,
    capabilities: metadata.capabilities,
  }
  if (catalog.defaultModel) profile.defaultModel = catalog.defaultModel
  if (catalog.configuredModel) profile.configuredModel = catalog.configuredModel
  return profile
}

export function unavailableHarnessProfile(
  harness: string,
  error: string
): HarnessProfile {
  const metadata = harnessMetadata(harness)
  return {
    id: harness,
    label: metadata.label,
    available: false,
    transport: metadata.transport,
    models: [],
    capabilities: metadata.capabilities,
    error,
  }
}

export function harnessModelByIdentity(
  models: HarnessModel[],
  identity: string | undefined
): HarnessModel | undefined {
  if (!identity) return undefined
  return models.find(
    (model) =>
      model.id === identity ||
      model.launchId === identity ||
      model.aliases?.includes(identity)
  )
}

export function canonicalHarnessModelId(
  profile: HarnessProfile,
  identity: string | undefined
): string | undefined {
  return harnessModelByIdentity(profile.models, identity)?.id
}

export function resolveHarnessTuning(
  profile: HarnessProfile,
  tuning: HarnessTuning | undefined
): HarnessTuning | undefined {
  if (!tuning?.model) return tuning
  const model = harnessModelByIdentity(profile.models, tuning.model)
  if (!model) {
    return {
      ...tuning,
      model: undefined,
      effort: undefined,
      fast: undefined,
      options: undefined,
    }
  }
  if (!model.variants?.length) {
    return { ...tuning, model: model.launchId ?? model.id }
  }
  const selected = new Map<string, string | boolean>()
  for (const option of model.options) {
    if (option.kind === "select") {
      const current = option.current ?? option.values.find((value) => value.default)?.value
      if (current !== undefined) selected.set(option.id, current)
    } else {
      selected.set(option.id, option.current)
    }
  }
  for (const [key, value] of Object.entries(tuning.options ?? {})) {
    if (model.options.some((option) => option.id === key)) selected.set(key, value)
  }
  if (tuning.effort && model.options.some((option) => option.id === "effort")) {
    selected.set("effort", tuning.effort)
  }
  if (tuning.fast !== undefined && model.options.some((option) => option.id === "fast")) {
    selected.set("fast", tuning.fast)
  }
  const variant = model.variants.find((candidate) =>
    [...selected].every(([key, value]) => variantValue(candidate, key) === value)
  ) ?? model.variants.find((candidate) => candidate.id === model.launchId) ?? model.variants[0]
  return { ...tuning, model: variant.id }
}

export function normalizeClaudeModels(response: ClaudeModelRow[]): HarnessModelCatalog {
  const defaultResolved = response.find((row) => row.value === "default")?.resolvedModel
  const byId = new Map<string, HarnessModel>()
  for (const row of response) {
    const launchId = presentString(row.value)
    if (!launchId || launchId === "default") continue
    const id = presentString(row.resolvedModel) ?? launchId
    if (byId.has(id)) continue
    const options: HarnessModelOption[] = []
    const efforts = row.supportedEffortLevels?.filter(Boolean) ?? []
    if (row.supportsEffort && efforts.length > 0) {
      options.push(selectOption("effort", "Reasoning", efforts))
    }
    if (row.supportsFastMode) {
      options.push({ kind: "boolean", id: "fast", label: "Fast mode", current: false })
    }
    const model: HarnessModel = {
      id,
      launchId,
      label: presentString(row.displayName) ?? id,
      options,
    }
    if (row.description) model.description = row.description
    byId.set(id, model)
  }
  const catalog: HarnessModelCatalog = { models: [...byId.values()] }
  if (defaultResolved && byId.has(defaultResolved)) catalog.defaultModel = defaultResolved
  return catalog
}

export function normalizeCodexModels(result: CodexModelListResponse): HarnessModelCatalog {
  if (!Array.isArray(result.data)) throw new Error("Codex did not return its model catalog")
  let defaultModel: string | undefined
  const byId = new Map<string, HarnessModel>()
  for (const row of result.data) {
    const id = presentString(row.model)
    if (!id || byId.has(id)) continue
    if (row.isDefault) defaultModel = id
    const options: HarnessModelOption[] = []
    const efforts: HarnessSelectValue[] = []
    for (const entry of row.supportedReasoningEfforts ?? []) {
      const value = presentString(entry.reasoningEffort)
      if (!value) continue
      efforts.push({
        value,
        label: effortLabel(value),
        default: value === row.defaultReasoningEffort,
      })
    }
    if (efforts.length > 0) {
      options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        current: presentString(row.defaultReasoningEffort),
        values: efforts,
      })
    }
    const tiers: HarnessSelectValue[] = []
    for (const entry of row.serviceTiers ?? []) {
      const value = presentString(entry.id)
      if (!value) continue
      const tier: HarnessSelectValue = {
        value,
        label: presentString(entry.name) ?? value,
      }
      if (entry.description) tier.description = entry.description
      tiers.push(tier)
    }
    if (tiers.length > 0) {
      options.push({
        kind: "select",
        id: "serviceTier",
        label: "Speed",
        current: presentString(row.defaultServiceTier),
        values: tiers,
      })
    }
    const model: HarnessModel = {
      id,
      label: presentString(row.displayName) ?? id,
      options,
    }
    if (row.description) model.description = row.description
    byId.set(id, model)
  }
  const catalog: HarnessModelCatalog = { models: [...byId.values()] }
  if (defaultModel) catalog.defaultModel = defaultModel
  return catalog
}

export function normalizeCursorModels(
  result: CursorModelListResponse,
  configuredModel?: string
): HarnessModelCatalog {
  if (!Array.isArray(result.models)) throw new Error("Cursor did not return its model catalog")
  const byId = new Map<string, HarnessModel>()
  for (const row of result.models) {
    const wireId = presentString(row.value)
    if (!wireId) continue
    const id = cursorBaseId(wireId)
    const existing = byId.get(id)
    if (existing) {
      if (wireId !== id) existing.aliases = uniqueStrings([...(existing.aliases ?? []), wireId])
      continue
    }
    const model: HarnessModel = {
      id,
      label: presentString(row.name) ?? id,
      options: normalizeAcpOptions(row.configOptions),
    }
    if (wireId !== id) model.aliases = [wireId]
    byId.set(id, model)
  }
  const models = [...byId.values()]
  const catalog: HarnessModelCatalog = { models }
  if (byId.has("auto-smart")) catalog.defaultModel = "auto-smart"
  const configured = harnessModelByIdentity(models, configuredModel)?.id
  if (configured) catalog.configuredModel = configured
  return catalog
}

export function normalizeGrokModels(
  output: string,
  cache: GrokModelCache | null
): HarnessModelCatalog {
  const listed = new Set<string>()
  let defaultModel: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    const item = /^(?:\*|-)\s+([^\s]+)(?:\s+\(default\))?$/.exec(trimmed)
    if (item?.[1]) {
      listed.add(item[1])
      if (trimmed.endsWith("(default)")) defaultModel = item[1]
    }
    const explicitDefault = /^Default model:\s*(\S+)/.exec(trimmed)
    if (explicitDefault?.[1]) defaultModel = explicitDefault[1]
  }
  const models = [...listed].map((id): HarnessModel => {
    const info = cache?.models?.[id]?.info
    const efforts: HarnessSelectValue[] = []
    for (const entry of info?.reasoning_efforts ?? []) {
      const value = presentString(entry.value)
      if (!value) continue
      const effort: HarnessSelectValue = {
        value,
        label: presentString(entry.label) ?? effortLabel(value),
      }
      if (entry.description) effort.description = entry.description
      if (entry.default) effort.default = true
      efforts.push(effort)
    }
    const model: HarnessModel = {
      id,
      label: presentString(info?.name) ?? id,
      options: [],
    }
    if (info?.description) model.description = info.description
    const contextWindow = positiveNumber(info?.context_window)
    if (contextWindow) model.contextWindow = contextWindow
    const maxOutputTokens = positiveNumber(info?.max_completion_tokens)
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens
    if (efforts.length > 0) {
      model.options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        current: presentString(info?.reasoning_effort),
        values: efforts,
      })
    }
    return model
  })
  const catalog: HarnessModelCatalog = { models }
  if (defaultModel && listed.has(defaultModel)) catalog.defaultModel = defaultModel
  return catalog
}

export function normalizeDevinModels(parsed: DevinModelListResponse): HarnessModelCatalog {
  const byId = new Map<string, HarnessModel>()
  let reportedDefault = presentString(parsed.default_model) ?? presentString(parsed.defaultModel)
  for (const family of parsed.families ?? []) {
    const id = presentString(family.slug)
    if (!id || byId.has(id)) continue
    const variants = normalizeDevinVariants(family.variants)
    if (variants.length === 0) continue
    const efforts = uniqueStrings(
      variants.flatMap((variant) => variantEffort(variant))
    ).sort(reasoningSort)
    const options: HarnessModelOption[] = []
    if (efforts.length > 0) {
      options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        current: variants.flatMap((variant) => variantEffort(variant))[0],
        values: efforts.map((value) => ({ value, label: effortLabel(value) })),
      })
    }
    if (variants.some((variant) => variant.values.fast === true)) {
      options.push({
        kind: "boolean",
        id: "fast",
        label: "Fast mode",
        current: variants[0]?.values.fast === true,
      })
    }
    const model: HarnessModel = {
      id,
      launchId: variants[0]!.id,
      label: presentString(family.family_label) ?? id,
      options,
      variants,
    }
    const aliases = uniqueStrings((family.aliases ?? []).filter((alias) => alias !== id))
    if (aliases.length > 0) model.aliases = aliases
    if (variants.length === 1 && variants[0]?.description) {
      model.description = variants[0].description
    }
    const contextWindows = uniqueNumbers(variants.map((variant) => variant.contextWindow))
    if (contextWindows.length === 1) model.contextWindow = contextWindows[0]
    const outputLimits = uniqueNumbers(variants.map((variant) => variant.maxOutputTokens))
    if (outputLimits.length === 1) model.maxOutputTokens = outputLimits[0]
    byId.set(id, model)
    if (family.is_default) reportedDefault = id
    const defaultVariant = family.variants?.find((variant) => variant.is_default)
    if (defaultVariant?.model_uid) reportedDefault = defaultVariant.model_uid
  }
  const models = [...byId.values()]
  const defaultModel = canonicalDevinDefault(models, reportedDefault)
  models.sort((left, right) =>
    left.id === "adaptive" ? -1 : right.id === "adaptive" ? 1 : 0
  )
  const catalog: HarnessModelCatalog = { models }
  if (defaultModel) catalog.defaultModel = defaultModel
  return catalog
}

export function normalizeAcpOptions(
  options: AcpConfigOptionInput[] | undefined
): HarnessModelOption[] {
  if (!Array.isArray(options)) return []
  const normalized: HarnessModelOption[] = []
  for (const option of options) {
    const id = presentString(option.id)
    if (!id) continue
    const label = presentString(option.name) ?? id
    if (option.type === "boolean") {
      normalized.push({
        kind: "boolean",
        id,
        label,
        current: option.currentValue === true,
      })
      continue
    }
    if (option.type !== "select") continue
    const entries = Array.isArray(option.options)
      ? option.options
      : Object.values(option.options ?? {}).flat()
    const flat = entries.flatMap((entry) =>
      "options" in entry ? entry.options : [entry]
    )
    const values: HarnessSelectValue[] = []
    for (const entry of flat) {
      const value = presentString(entry.value)
      if (!value) continue
      const item: HarnessSelectValue = {
        value,
        label: presentString(entry.name) ?? value,
      }
      if (entry.description) item.description = entry.description
      values.push(item)
    }
    if (values.length === 0) continue
    const wireValues = new Set(values.map((value) => value.value))
    const select: HarnessModelOption = {
      kind: "select",
      id,
      label,
      current: selectCurrentValue(option.currentValue),
      values,
    }
    if (wireValues.size === 2 && wireValues.has("true") && wireValues.has("false")) {
      select.presentation = "toggle"
    }
    normalized.push(select)
  }
  return normalized
}

function normalizeDevinVariants(raw: DevinVariantRow[] | undefined): HarnessModelVariant[] {
  const byId = new Map<string, HarnessModelVariant>()
  for (const row of raw ?? []) {
    const id = presentString(row.model_uid)
    if (!id || byId.has(id)) continue
    const label = presentString(row.label) ?? id
    const effort = reasoningFrom(`${id} ${label}`)
    const fast = /(?:^|[- ])(?:fast|priority)(?:$|[- ])/i.test(`${id} ${label}`)
    const values: Record<string, string | boolean> = {}
    if (effort) values.effort = effort
    if (fast) values.fast = true
    const variant: HarnessModelVariant = { id, label, values }
    const contextWindow = positiveNumber(row.max_context_tokens)
    if (contextWindow) variant.contextWindow = contextWindow
    const maxOutputTokens = positiveNumber(row.max_output_tokens)
    if (maxOutputTokens) variant.maxOutputTokens = maxOutputTokens
    if (row.description) variant.description = row.description
    byId.set(id, variant)
  }
  return [...byId.values()]
}

interface HarnessMetadata {
  label: string
  transport: HarnessProfile["transport"]
  capabilities: string[]
}

function harnessMetadata(harness: string): HarnessMetadata {
  if (harness === "claude") {
    return {
      label: "Claude Code",
      transport: "acp",
      capabilities: ["start", "resume", "fork", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models"],
    }
  }
  if (harness === "codex") {
    return {
      label: "Codex",
      transport: "app-server",
      capabilities: ["start", "resume", "fork-at-turn", "stream", "steer", "interrupt", "permissions", "images", "audio", "skills", "mcp", "models", "review"],
    }
  }
  if (harness === "cursor") {
    return {
      label: "Cursor",
      transport: "acp",
      capabilities: ["start", "resume-acp", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models"],
    }
  }
  if (harness === "grok") {
    return {
      label: "Grok",
      transport: "acp",
      capabilities: ["start", "resume", "fork", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models", "memory"],
    }
  }
  if (harness === "devin") {
    return {
      label: "Devin",
      transport: "acp",
      capabilities: ["start", "resume", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models", "cloud"],
    }
  }
  return { label: harness, transport: "remote", capabilities: [] }
}

function canonicalDevinDefault(models: HarnessModel[], identity: string | undefined): string | undefined {
  const direct = harnessModelByIdentity(models, identity)?.id
  if (direct) return direct
  if (!identity) return undefined
  return models.find((model) => model.variants?.some((variant) => variant.id === identity))?.id
}

function cursorBaseId(value: string): string {
  return /^(.*?)\[[^\]]+\]$/.exec(value)?.[1] ?? value
}

function variantValue(
  variant: HarnessModelVariant,
  key: string
): string | boolean | undefined {
  const value = variant.values[key]
  if (value !== undefined) return value
  return key === "fast" ? false : undefined
}

function variantEffort(variant: HarnessModelVariant): string[] {
  const effort = variant.values.effort
  return effort === true || effort === false || effort === undefined ? [] : [effort]
}

function selectOption(id: string, label: string, values: string[]): HarnessModelOption {
  return {
    kind: "select",
    id,
    label,
    values: values.map((value) => ({ value, label: effortLabel(value) })),
  }
}

function reasoningFrom(value: string): string | undefined {
  return REASONING_ORDER.find((effort) =>
    new RegExp(`(?:^|[- ])${effort}(?:$|[- ])`, "i").test(value)
  )
}

function reasoningSort(left: string, right: string): number {
  const leftIndex = REASONING_ORDER.indexOf(left)
  const rightIndex = REASONING_ORDER.indexOf(right)
  return (leftIndex < 0 ? REASONING_ORDER.length : leftIndex) -
    (rightIndex < 0 ? REASONING_ORDER.length : rightIndex)
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra high"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function presentString(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? value : undefined
}

function selectCurrentValue(value: string | boolean | undefined): string | undefined {
  return value === true || value === false ? undefined : value
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value) => value !== undefined))]
}
