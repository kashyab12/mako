import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { hostname } from "node:os"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import {
  backendRelayPost,
  backendRelayUpload,
} from "./backend-connection.js"
import {
  abortNative,
  resumeNative,
  startFresh,
  subscribeNativeRunOutput,
  waitForNativeRun,
  type FreshOptions,
} from "./drivers.js"
import { harnessProfile, resolveHarnessTuning } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { HarnessModelOption } from "./shared.js"
import { listThreads, transcriptInlineFor } from "./threads.js"

const HarnessSchema = z.string().min(1).max(80)

const SelectionSchema = z.object({
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: HarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})

const OriginSchema = z.object({
  provider: z.string(),
  tenantId: z.string(),
  conversationId: z.string(),
  threadId: z.string(),
  eventId: z.string(),
  userId: z.string(),
})

const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["audio", "file", "image", "video"]),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
})

const PayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    forceNew: z.boolean().default(false),
    attachments: z.array(AttachmentSchema).default([]),
    selection: SelectionSchema,
    origin: OriginSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("resume"),
    attachments: z.array(AttachmentSchema).default([]),
    selection: SelectionSchema,
    origin: OriginSchema,
    text: z.string(),
    threadPath: z.string(),
  }),
  z.object({
    kind: z.literal("resume-query"),
    attachments: z.array(AttachmentSchema).default([]),
    query: z.string(),
    selection: SelectionSchema,
    origin: OriginSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("inspect-threads"),
    query: z.string().optional(),
    selection: SelectionSchema,
    origin: OriginSchema,
  }),
  z.object({
    kind: z.literal("inspect-models"),
    selection: SelectionSchema,
    origin: OriginSchema,
  }),
  z.object({
    kind: z.literal("configure"),
    selection: SelectionSchema,
    origin: OriginSchema,
    threadPath: z.string(),
  }),
])

const LeaseSchema = z.object({
  kind: z.literal("job"),
  lease: z.object({
    jobId: z.uuid(),
    messageId: z.string(),
    payload: PayloadSchema,
    popReceipt: z.string(),
  }),
})

const EmptySchema = z.object({ kind: z.literal("empty") })

interface SlackRelayOptions {
  defaultCwd: () => string
  deviceFile: string
  version: string
}

let timer: ReturnType<typeof setTimeout> | undefined
let activeLeaseAbort: AbortController | undefined
let activePollAbort: AbortController | undefined
let emptyPolls = 0
let stopped = true

async function deviceId(path: string): Promise<string> {
  try {
    const id = z.uuid().parse((await readFile(path, "utf8")).trim())
    await chmod(path, 0o600)
    return id
  } catch {
    const id = randomUUID()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${id}\n`, { mode: 0o600 })
    return id
  }
}

function selectOption(
  options: HarnessModelOption[],
  id: string
): Extract<HarnessModelOption, { kind: "select" }> | undefined {
  return options.find(
    (option): option is Extract<HarnessModelOption, { kind: "select" }> =>
      option.kind === "select" && option.id === id
  )
}

function findThread(query: string): ThreadRef | undefined {
  const normalized = query.toLowerCase()
  const refs = listThreads()
  return (
    refs.find((ref) => ref.path === query || ref.nativeId === query) ??
    refs.find((ref) => ref.title?.toLowerCase().includes(normalized))
  )
}

async function waitForFreshThread({
  before,
  cwd,
  harness,
}: {
  before: Set<string>
  cwd: string
  harness: string
}): Promise<ThreadRef | undefined> {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    const found = listThreads({ harness }).find(
      (ref) => !before.has(ref.path) && (!ref.cwd || ref.cwd === cwd)
    )
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

async function stageRelayAttachments(
  payload: z.infer<typeof PayloadSchema>,
  jobId: string,
  deviceId: string,
  cwd: string
): Promise<{
  paths: string[]
  manifestPath: string
  cleanup: () => Promise<void>
}> {
  const attachments = "attachments" in payload ? payload.attachments : []
  const directory = join(cwd, `.mako-relay-${jobId}`)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const attachmentDirectory = join(directory, "attachments")
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 })
  const manifestPath = join(directory, "outbound-files.json")
  const paths: string[] = []
  let total = 0
  try {
    for (const attachment of attachments) {
      const response = await backendRelayPost(
        "/api/relay/attachment",
        JSON.stringify({ attachmentId: attachment.id, deviceId, jobId })
      )
      if (!response.ok)
        throw new Error(`Attachment download returned ${response.status}`)
      const declared = Number(response.headers.get("content-length") ?? "0")
      if (declared > 100 * 1024 * 1024)
        throw new Error(`${attachment.name} exceeds Mako's 100 MB file limit`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      total += bytes.byteLength
      if (bytes.byteLength > 100 * 1024 * 1024 || total > 200 * 1024 * 1024)
        throw new Error("Slack attachments exceed Mako's 200 MB job limit")
      const decoded = decodeURIComponent(
        response.headers.get("x-mako-attachment-name") ?? attachment.name
      )
      const name = basename(decoded).replace(/[\p{Cc}\\/:]/gu, "_")
      if (!name || name === "." || name === "..")
        throw new Error("Slack returned an invalid attachment name")
      const prefix = attachment.id.replace(/[^a-zA-Z0-9._-]/g, "_")
      const path = join(attachmentDirectory, `${prefix}-${name}`)
      await writeFile(path, bytes, { mode: 0o600 })
      paths.push(path)
    }
    return {
      paths,
      manifestPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function relayPrompt(
  text: string,
  paths: string[],
  manifestPath: string
): string {
  const attached =
    paths.length > 0
      ? `\n\nFiles attached by the user:\n${paths.map((path) => `- ${path}`).join("\n")}`
      : ""
  return `${text}${attached}\n\nIf you create files the user should receive, write a JSON array of their paths to ${manifestPath}. Only include files inside the current workspace. Do not mention this delivery instruction in your answer.`
}

const OutboundFilesSchema = z.array(z.string().min(1).max(4_000)).max(5)

async function uploadRelayArtifacts({
  cwd,
  deviceId,
  jobId,
  manifestPath,
}: {
  cwd: string
  deviceId: string
  jobId: string
  manifestPath: string
}): Promise<void> {
  let manifest: string
  try {
    manifest = await readFile(manifestPath, "utf8")
  } catch {
    return
  }
  const listed = OutboundFilesSchema.parse(JSON.parse(manifest))
  const root = await realpath(cwd)
  for (const requested of listed) {
    const path = await realpath(
      isAbsolute(requested) ? requested : resolve(root, requested)
    )
    const local = relative(root, path)
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local)
    )
      throw new Error("A returned Slack file must be inside the workspace")
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${requested} is not a file`)
    if (info.size > 25 * 1024 * 1024)
      throw new Error(`${requested} exceeds Slack's 25 MB relay limit`)
    const bytes = await readFile(path)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const body = new FormData()
    const artifactKey = createHash("sha256")
      .update(local)
      .digest("hex")
      .slice(0, 32)
    body.set("artifactKey", artifactKey)
    body.set("deviceId", deviceId)
    body.set("jobId", jobId)
    body.set("file", new Blob([buffer]), basename(path))
    const response = await backendRelayUpload("/api/relay/artifact", body)
    if (!response.ok)
      throw new Error(`Relay artifact upload returned ${response.status}`)
  }
}

async function executePayload(
  payload: z.infer<typeof PayloadSchema>,
  defaultCwd: string,
  signal: AbortSignal,
  jobId: string,
  deviceId: string,
  onOutput: (chunk: string) => void
): Promise<{
  effort?: string
  fast?: boolean
  harness: z.infer<typeof HarnessSchema>
  model?: string
  result: string
  status?: "done" | "failed" | "stopped"
  threadPath?: string
}> {
  const requested = payload.selection.harness
  if (payload.kind === "inspect-threads") {
    const query = payload.query?.toLowerCase()
    const refs = listThreads()
      .filter(
        (ref) =>
          !query ||
          ref.nativeId.toLowerCase().includes(query) ||
          ref.path.toLowerCase().includes(query) ||
          ref.title?.toLowerCase().includes(query)
      )
      .slice(0, 15)
    return {
      harness: requested ?? "codex",
      result:
        refs.length > 0
          ? refs
              .map(
                (ref) =>
                  `• *${ref.title ?? "Untitled thread"}* — \`${ref.harness}\` — \`${ref.nativeId}\``
              )
              .join("\n")
          : "Mako found no local threads matching that search.",
    }
  }
  const source =
    payload.kind === "resume" || payload.kind === "configure"
      ? findThread(payload.threadPath)
      : payload.kind === "resume-query"
        ? findThread(payload.query)
        : undefined
  const failureThreadPath =
    payload.kind === "configure" ? undefined : source?.path
  if (
    (payload.kind === "resume" ||
      payload.kind === "resume-query" ||
      payload.kind === "configure") &&
    !source
  ) {
    const query = payload.kind === "resume-query" ? payload.query : payload.threadPath
    return {
      harness: requested ?? "codex",
      model: payload.selection.model,
      result: `Mako could not find the local thread \`${query}\`. Send \`threads\` to list resumable threads.`,
    }
  }
  const harness = requested ?? HarnessSchema.parse(source?.harness ?? "codex")
  const profile = await harnessProfile(harness)
  if (!profile.available) {
    return {
      harness,
      result: profile.error ?? `${profile.label} is not available on this Mac.`,
      threadPath: failureThreadPath,
    }
  }
  if (payload.kind === "inspect-models") {
    return {
      harness,
      result: profile.models
        .map((candidate) => {
          const controls = candidate.options.map((option) =>
            option.kind === "boolean"
              ? option.label
              : `${option.label}: ${option.values.map((value) => value.value).join(" | ")}`
          )
          return `• *${candidate.label}* — \`${candidate.id}\`${controls.length > 0 ? ` — ${controls.join(" · ")}` : ""}`
        })
        .join("\n"),
    }
  }
  const requestedModel =
    payload.selection.model ?? source?.model ?? profile.configuredModel ?? profile.defaultModel
  const selectedModel = requestedModel
    ? profile.models.find(
        (candidate) =>
          candidate.id === requestedModel ||
          candidate.aliases?.includes(requestedModel)
      )
    : undefined
  if (requestedModel && !selectedModel) {
    return {
      harness,
      result: `Mako could not find \`${requestedModel}\` for ${profile.label}. Send \`models ${harness}\` to list live models.`,
      threadPath: failureThreadPath,
    }
  }
  const effort = payload.selection.effort
  const effortOption = selectedModel
    ? selectOption(selectedModel.options, "effort")
    : undefined
  if (
    effort &&
    (!effortOption || !effortOption.values.some((value) => value.value === effort))
  ) {
    return {
      harness,
      model: selectedModel?.id,
      result: `\`${effort}\` is not available for this model. Send \`models ${harness}\` to see supported reasoning levels.`,
      threadPath: failureThreadPath,
    }
  }
  const fast = payload.selection.fast
  const fastOption = selectedModel?.options.find((option) => option.id === "fast")
  const speedOption = selectedModel
    ? selectOption(selectedModel.options, "serviceTier")
    : undefined
  if (
    fast !== undefined &&
    providerHost.nativeRunners.get(harness)?.fastMode === "unsupported"
  ) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `${profile.label} print mode does not currently expose its fast-mode control. Reasoning and model selection still work.`,
      threadPath: failureThreadPath,
    }
  }
  if (fast !== undefined && !fastOption && !speedOption) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Fast mode is not available for \`${selectedModel?.id ?? harness}\`.`,
      threadPath: failureThreadPath,
    }
  }
  const serviceTier = speedOption?.values.find((value) =>
    fast
      ? /fast|priority/i.test(`${value.value} ${value.label}`)
      : /flex|standard|default/i.test(`${value.value} ${value.label}`)
  )?.value
  if (fast !== undefined && speedOption && !serviceTier) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Mako could not map fast \`${fast ? "on" : "off"}\` to a speed tier for this model. Send \`models ${harness}\` to see its controls.`,
      threadPath: failureThreadPath,
    }
  }
  const resolved = resolveHarnessTuning(profile, {
    model: selectedModel?.id,
    effort,
    fast,
    options: serviceTier ? { serviceTier } : undefined,
  })
  const options: FreshOptions = {
    ...resolved,
    captureOutput: true,
  }
  const model = selectedModel?.id
  if (payload.kind === "configure") {
    return {
      effort,
      fast,
      harness,
      model,
      result: `Updated this thread: harness \`${harness}\`${model ? ` · model \`${model}\`` : ""}${effort ? ` · reasoning \`${effort}\`` : ""}${fast === undefined ? "" : ` · fast \`${fast ? "on" : "off"}\``}.`,
      threadPath: source?.path,
    }
  }
  const cwd = source?.cwd ?? defaultCwd
  const staged = await stageRelayAttachments(payload, jobId, deviceId, cwd)
  try {
    const text = relayPrompt(payload.text, staged.paths, staged.manifestPath)
    const before = new Set(listThreads().map((ref) => ref.path))
    const run =
      source && source.harness === harness
        ? await resumeNative(source, text, options)
        : await startFresh(
            harness,
            cwd,
            source
              ? `${(await transcriptInlineFor(source.path))?.content ?? ""}\n\nContinue this conversation with the user's new message:\n${text}`
              : text,
            options
          )
    const unsubscribe = subscribeNativeRunOutput(run.path, onOutput)
    if (signal.aborted) {
      abortNative(run.path)
      throw new Error("The remote relay lease was lost before execution started")
    }
    const abort = () => abortNative(run.path)
    signal.addEventListener("abort", abort, { once: true })
    const completed = await waitForNativeRun(run.path).finally(() => {
      unsubscribe()
      signal.removeEventListener("abort", abort)
    })
    let artifactWarning = ""
    try {
      await uploadRelayArtifacts({
        cwd,
        deviceId,
        jobId,
        manifestPath: staged.manifestPath,
      })
    } catch (error) {
      artifactWarning = `\n\nMako could not return a generated file: ${error instanceof Error ? error.message : String(error)}`
    }
    if (completed.state.status !== "done") {
      return {
        effort,
        fast,
        harness,
        model,
        result:
          `${completed.state.error ?? `${harness} stopped before completing the turn.`}${artifactWarning}`,
        status:
          completed.state.status === "stopped" ? "stopped" : "failed",
        threadPath: failureThreadPath,
      }
    }
    const ref =
      source && source.harness === harness
        ? source
        : await waitForFreshThread({ before, cwd, harness })
    return {
      effort,
      fast,
      harness,
      model: model ?? ref?.model,
      result:
        `${completed.text || `${harness} completed the turn without printable output.`}${artifactWarning}`,
      status: "done",
      threadPath: ref?.path,
    }
  } finally {
    await staged.cleanup()
  }
}

async function renewLease(
  id: string,
  lease: z.infer<typeof LeaseSchema>["lease"],
  popReceipt: string
): Promise<string> {
  let failure: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const renewed = await backendRelayPost(
        "/api/relay/renew",
        JSON.stringify({
          deviceId: id,
          jobId: lease.jobId,
          messageId: lease.messageId,
          popReceipt,
          visibilityTimeoutSeconds: 300,
        })
      )
      if (!renewed.ok) {
        throw new Error(`Relay renewal returned ${renewed.status}`)
      }
      return z
        .object({ popReceipt: z.string().min(1) })
        .parse(z.json().parse(await renewed.json())).popReceipt
    } catch (error) {
      failure = error
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }
  throw failure
}

async function completeRelay(body: string): Promise<void> {
  let failure: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await backendRelayPost("/api/relay/complete", body)
      if (response.ok) return
      failure = new Error(`Relay completion returned ${response.status}`)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw failure ?? new Error("Relay completion failed")
}

interface ProgressWriter {
  close: () => Promise<void>
  failed: () => boolean
  push: (chunk: string) => void
}

function createProgressWriter(
  deviceId: string,
  jobId: string
): ProgressWriter {
  let pending = ""
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let delivery = Promise.resolve()
  let failed = false
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    while (pending) {
      const text = pending.slice(0, 11_000)
      pending = pending.slice(text.length)
      sequence += 1
      const current = sequence
      delivery = delivery
        .then(async () => {
          if (failed) return
          const response = await backendRelayPost(
            "/api/relay/progress",
            JSON.stringify({ deviceId, jobId, sequence: current, text })
          )
          if (!response.ok)
            throw new Error(`Relay progress returned ${response.status}`)
        })
        .catch(() => {
          failed = true
        })
    }
  }
  return {
    failed: () => failed,
    push(chunk) {
      if (!chunk || failed) return
      pending += chunk
      timer ??= setTimeout(flush, 750)
    },
    async close() {
      flush()
      await delivery
    },
  }
}

async function poll(options: SlackRelayOptions, id: string): Promise<void> {
  if (stopped) return
  try {
    const pollAbort = new AbortController()
    activePollAbort = pollAbort
    const response = await backendRelayPost(
      "/api/relay/lease",
      JSON.stringify({
        defaultHarness: "codex",
        deviceId: id,
        deviceName: hostname(),
        version: options.version,
        visibilityTimeoutSeconds: 300,
      }),
      pollAbort.signal
    ).finally(() => {
      if (activePollAbort === pollAbort) activePollAbort = undefined
    })
    if (stopped) return
    if (!response.ok) throw new Error(`Relay lease returned ${response.status}`)
    const value = z.json().parse(await response.json())
    const empty = EmptySchema.safeParse(value)
    if (empty.success) emptyPolls = Math.min(emptyPolls + 1, 4)
    if (!empty.success) {
      emptyPolls = 0
      const leased = LeaseSchema.parse(value).lease
      let popReceipt = leased.popReceipt
      let renewal = Promise.resolve()
      const leaseAbort = new AbortController()
      activeLeaseAbort = leaseAbort
      const renewTimer = setInterval(() => {
        renewal = renewal
          .then(async () => {
            popReceipt = await renewLease(id, leased, popReceipt)
          })
          .catch(() => {
            leaseAbort.abort()
            throw new Error("Relay lease renewal failed")
          })
      }, 180_000)
      const progress = createProgressWriter(id, leased.jobId)
      let control = Promise.resolve()
      const checkControl = () => {
        control = control
          .then(async () => {
            const response = await backendRelayPost(
              "/api/relay/control",
              JSON.stringify({ deviceId: id, jobId: leased.jobId })
            )
            if (!response.ok) return
            const value = z
              .object({ control: z.literal("stop").nullable() })
              .parse(z.json().parse(await response.json()))
            if (value.control === "stop") leaseAbort.abort()
          })
          .catch(() => undefined)
      }
      const controlTimer = setInterval(checkControl, 2_000)
      checkControl()
      let execution: Awaited<ReturnType<typeof executePayload>>
      try {
        execution = await executePayload(
          leased.payload,
          options.defaultCwd(),
          leaseAbort.signal,
          leased.jobId,
          id,
          progress.push
        )
      } finally {
        clearInterval(renewTimer)
        clearInterval(controlTimer)
        if (activeLeaseAbort === leaseAbort) activeLeaseAbort = undefined
        await Promise.all([renewal, control, progress.close()])
      }
      await completeRelay(
        JSON.stringify({
          deviceId: id,
          effort: execution.effort,
          fast: execution.fast,
          harness: execution.harness,
          jobId: leased.jobId,
          messageId: leased.messageId,
          model: execution.model,
          popReceipt,
          progressFailed: progress.failed(),
          result: execution.result,
          status: execution.status ?? "done",
          threadPath: execution.threadPath,
        })
      )
    }
  } catch {
    if (!stopped) timer = setTimeout(() => void poll(options, id), 5_000)
    return
  }
  if (!stopped) {
    timer = setTimeout(
      () => void poll(options, id),
      Math.min(1_500 * 2 ** emptyPolls, 15_000)
    )
  }
}

export async function startSlackRelay(options: SlackRelayOptions): Promise<void> {
  if (!stopped) return
  emptyPolls = 0
  stopped = false
  void poll(options, await deviceId(options.deviceFile))
}

export function stopSlackRelay(): void {
  stopped = true
  activePollAbort?.abort()
  activePollAbort = undefined
  activeLeaseAbort?.abort()
  activeLeaseAbort = undefined
  if (timer) clearTimeout(timer)
  timer = undefined
}
