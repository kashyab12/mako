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
import type { ThreadEntry, ThreadRef } from "@mako/sessions"
import {
  HeadlessRelayWorker,
  RelayHarnessSchema,
  RelayLeaseSchema,
  parseRelayJobPayload,
  type RelayCanonicalEvent,
  type RelayHarness,
  type RelayJobPayload,
  type RelayLease,
} from "@mako/relay"
import {
  backendRelayPost,
  backendRelayUpload,
  configureBackendRelayDevice,
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
import {
  listThreads,
  subscribeThreadEvents,
  transcriptInlineFor,
} from "./threads.js"

const RawLeaseSchema = z.object({
  kind: z.literal("job"),
  lease: z.object({
    jobId: z.uuid(),
    messageId: z.string(),
    payload: z.json(),
    popReceipt: z.string(),
  }),
})

function parseLease<Value>(value: Value): RelayLease {
  const raw = RawLeaseSchema.parse(value).lease
  return RelayLeaseSchema.parse({
    ...raw,
    payload: parseRelayJobPayload(raw.payload),
  })
}

const EmptySchema = z.object({ kind: z.literal("empty") })

interface SlackRelayOptions {
  defaultCwd: () => string
  deviceFile: string
  version: string
}

let relayWorker: HeadlessRelayWorker | null = null

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
  payload: RelayJobPayload,
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

function canonicalEvents(
  entries: ThreadEntry[],
  seen: Map<string, string>
): RelayCanonicalEvent[] {
  const events: RelayCanonicalEvent[] = []
  let reasoning = 0
  for (const entry of entries) {
    if (entry.kind === "event" && /plan/i.test(entry.label)) {
      const id = createHash("sha256")
        .update(`${entry.label}\0${entry.detail ?? ""}`)
        .digest("hex")
        .slice(0, 24)
      if (seen.get(id) === entry.detail) continue
      seen.set(id, entry.detail ?? "")
      events.push({
        kind: "plan",
        id,
        title: entry.label,
        entries: entry.detail
          ? [
              {
                id: `${id}-detail`,
                title: entry.detail.slice(0, 256),
                status: "in_progress",
              },
            ]
          : [],
      })
      continue
    }
    if (entry.kind !== "assistant") continue
    for (const block of entry.blocks) {
      if (block.type === "text") {
        for (const [id, value] of seen) {
          if (!id.startsWith("reasoning-") || value === "completed") continue
          seen.set(id, "completed")
          events.push({
            kind: "reasoning",
            id,
            title: "Reasoning",
            status: "completed",
          })
        }
      } else if (block.type === "thinking") {
        reasoning += 1
        const id = `reasoning-${reasoning}`
        const detail = block.text.slice(-2_000)
        if (seen.get(id) === detail) continue
        seen.set(id, detail)
        events.push({
          kind: "reasoning",
          id,
          title: "Reasoning",
          status: "in_progress",
          detail,
        })
      } else if (block.type === "tool") {
        const id = createHash("sha256")
          .update(`${block.name}\0${block.input ?? ""}`)
          .digest("hex")
          .slice(0, 24)
        const fingerprint = `${block.output ?? ""}\0${block.error ?? false}`
        if (seen.get(id) === fingerprint) continue
        seen.set(id, fingerprint)
        events.push({
          kind: "tool",
          id,
          title: block.name,
          status: block.error
            ? "failed"
            : block.output === undefined
              ? "in_progress"
              : "completed",
          detail: block.input?.slice(0, 2_000),
          output: block.output?.slice(0, 4_000),
        })
      }
    }
  }
  return events
}

async function executePayload(
  payload: RelayJobPayload,
  defaultCwd: string,
  signal: AbortSignal,
  jobId: string,
  deviceId: string,
  onOutput: (chunk: string) => void,
  onEvent: (event: RelayCanonicalEvent) => void
): Promise<{
  effort?: string
  fast?: boolean
  harness: RelayHarness
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
  const harness =
    requested ?? RelayHarnessSchema.parse(source?.harness ?? "codex")
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
  let unsubscribeThread = () => {}
  try {
    const text = relayPrompt(payload.text, staged.paths, staged.manifestPath)
    const before = new Set(listThreads().map((ref) => ref.path))
    let watchedPath = source?.path
    const seenEvents = new Map<string, string>()
    unsubscribeThread = subscribeThreadEvents((event) => {
      if (
        !watchedPath &&
        event.type === "thread-ref" &&
        !before.has(event.ref.path) &&
        event.ref.harness === harness &&
        (!event.ref.cwd || event.ref.cwd === cwd)
      )
        watchedPath = event.ref.path
      if (
        watchedPath &&
        event.type === "thread-entries" &&
        event.path === watchedPath
      )
        for (const update of canonicalEvents(event.entries, seenEvents))
          onEvent(update)
    })
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
    unsubscribeThread()
    await staged.cleanup()
  }
}

async function renewLease(
  id: string,
  lease: RelayLease,
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
  const response = await backendRelayPost("/api/relay/complete", body)
  if (!response.ok)
    throw new Error(`Relay completion returned ${response.status}`)
}

function createRelayWorker(
  options: SlackRelayOptions,
  id: string
): HeadlessRelayWorker {
  return new HeadlessRelayWorker(
    {
      async lease(request, signal) {
        const response = await backendRelayPost(
          "/api/relay/lease",
          JSON.stringify(request),
          signal
        )
        if (!response.ok)
          throw new Error(`Relay lease returned ${response.status}`)
        const value = z.json().parse(await response.json())
        return EmptySchema.safeParse(value).success ? null : parseLease(value)
      },
      renew: (lease) => renewLease(id, lease, lease.popReceipt),
      async sendEvents(batch) {
        const response = await backendRelayPost(
          "/api/relay/events",
          JSON.stringify(batch)
        )
        if (!response.ok)
          throw new Error(`Relay events returned ${response.status}`)
      },
      async control(lease) {
        const response = await backendRelayPost(
          "/api/relay/control",
          JSON.stringify({ deviceId: id, jobId: lease.jobId })
        )
        if (!response.ok) return null
        return z
          .object({ control: z.literal("stop").nullable() })
          .parse(z.json().parse(await response.json())).control
      },
      complete: (completion) => completeRelay(JSON.stringify(completion)),
    },
    {
      async execute(lease, context) {
        const execution = await executePayload(
          lease.payload,
          options.defaultCwd(),
          context.signal,
          lease.jobId,
          id,
          (chunk) => {
            for (let offset = 0; offset < chunk.length; offset += 32_000) {
              const text = chunk.slice(offset, offset + 32_000)
              if (text) context.emit({ kind: "text", text })
            }
          },
          context.emit
        )
        return { ...execution, status: execution.status ?? "done" }
      },
    },
    {
      heartbeat: {
        defaultHarness: "codex",
        deviceId: id,
        deviceName: hostname(),
        version: options.version,
      },
    }
  )
}

export async function startSlackRelay(options: SlackRelayOptions): Promise<void> {
  if (relayWorker) return
  const id = await deviceId(options.deviceFile)
  await configureBackendRelayDevice({
    deviceId: id,
    deviceName: hostname(),
    defaultHarness: "codex",
  })
  relayWorker = createRelayWorker(options, id)
  relayWorker.start()
}

export function stopSlackRelay(): void {
  const worker = relayWorker
  relayWorker = null
  if (worker) void worker.stop()
}
