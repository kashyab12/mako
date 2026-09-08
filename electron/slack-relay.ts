import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import {
  HeadlessRelayWorker,
  RelayControlSchema,
  RelayHarnessSchema,
  RelayJobPayloadSchema,
  RelayLeaseSchema,
  type RelayCanonicalEvent,
  type RelayHarness,
  type RelayJobPayload,
  type RelayLease,
  type RelayPresentation,
} from "@mako/relay"
import {
  backendRelayPost,
  configureBackendRelayDevice,
} from "./backend-connection.js"
import type { RelayConversations } from "./relay-conversations.js"
import { harnessProfile, resolveHarnessTuning } from "./harnesses.js"
import {
  relayPrompt,
  stageRelayAttachments,
  uploadRelayArtifacts,
} from "./relay-artifacts.js"
import type { HarnessModelOption } from "./shared.js"
import { listThreads } from "./threads.js"

const RawLeaseSchema = z.object({
  kind: z.literal("job"),
  lease: z.object({
    jobId: z.uuid(),
    messageId: z.string(),
    payload: z.json(),
    popReceipt: z.string(),
  }),
})

const LegacySlackOriginSchema = z.object({
  channel: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(80),
  threadTs: z.string().min(1).max(160),
  userId: z.string().min(1).max(80),
})

function parseDesktopRelayPayload<Value>(value: Value): RelayJobPayload {
  const current = RelayJobPayloadSchema.safeParse(value)
  if (current.success) return current.data
  const record = z.record(z.string(), z.json()).parse(value)
  const slack = LegacySlackOriginSchema.parse(record.slack)
  return RelayJobPayloadSchema.parse({
    ...record,
    attachments: record.attachments ?? [],
    origin: {
      provider: "slack",
      tenantId: slack.teamId,
      conversationId: slack.channel,
      threadId: slack.threadTs,
      eventId: slack.eventId,
      userId: slack.userId,
    },
  })
}

function parseLease<Value>(value: Value): RelayLease {
  const raw = RawLeaseSchema.parse(value).lease
  return RelayLeaseSchema.parse({
    ...raw,
    payload: parseDesktopRelayPayload(raw.payload),
  })
}

const EmptySchema = z.object({ kind: z.literal("empty") })

interface SlackRelayOptions {
  conversations: RelayConversations
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

async function executePayload(
  payload: RelayJobPayload,
  defaultCwd: string,
  signal: AbortSignal,
  jobId: string,
  deviceId: string,
  conversations: RelayConversations,
  onEvent: (event: RelayCanonicalEvent) => void
): Promise<{
  effort?: string
  fast?: boolean
  harness: RelayHarness
  model?: string
  presentation?: RelayPresentation
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
      presentation: {
        kind: "threads",
        items: refs.map((ref) => ({
          harness: ref.harness,
          path: ref.path,
          title: ref.title ?? "Untitled thread",
        })),
      },
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
      ? (conversations.ref(payload.threadPath) ??
        findThread(payload.threadPath))
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
    const query =
      payload.kind === "resume-query" ? payload.query : payload.threadPath
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
      presentation: {
        kind: "models",
        harness,
        items: profile.models.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
        })),
      },
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
    payload.selection.model ??
    source?.model ??
    profile.settings?.model
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
    (!effortOption ||
      !effortOption.values.some((value) => value.value === effort))
  ) {
    return {
      harness,
      model: selectedModel?.id,
      result: `\`${effort}\` is not available for this model. Send \`models ${harness}\` to see supported reasoning levels.`,
      threadPath: failureThreadPath,
    }
  }
  const fast = payload.selection.fast
  const fastOption = selectedModel?.options.find(
    (option) => option.id === "fast"
  )
  const speedOption = selectedModel
    ? selectOption(selectedModel.options, "serviceTier")
    : undefined
  if (fast !== undefined && !fastOption && !speedOption) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Fast mode is not available for \`${selectedModel?.id ?? harness}\`.`,
      threadPath: failureThreadPath,
    }
  }
  const serviceTier = fast === undefined ? undefined
    : fast ? speedOption?.booleanValues?.on : speedOption?.booleanValues?.off
  if (fast !== undefined && speedOption && !serviceTier) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Mako could not map fast \`${fast ? "on" : "off"}\` to a speed tier for this model. Send \`models ${harness}\` to see its controls.`,
      threadPath: failureThreadPath,
    }
  }
  const selectedOptions: NonNullable<Parameters<typeof resolveHarnessTuning>[1]>["options"] = {}
  if (effort) selectedOptions.effort = effort
  if (serviceTier) selectedOptions.serviceTier = serviceTier
  if (fast !== undefined && fastOption) selectedOptions.fast = fast
  const resolved = resolveHarnessTuning(profile, {
    model: selectedModel?.id,
    options: selectedOptions,
  })
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
    const execution = await conversations.execute({
      jobId,
      cwd,
      provider: harness,
      sourcePath: source?.path,
      tuning: resolved ?? {},
      text: relayPrompt(payload.text, staged.paths, staged.manifestPath),
      attachments: staged.paths.map((path, index) => ({
        path,
        name: payload.attachments[index]?.name ?? path,
        mimeType:
          payload.attachments[index]?.mimeType ?? "application/octet-stream",
        size: payload.attachments[index]?.size ?? 0,
      })),
      signal,
      emit: onEvent,
    })
    try {
      await uploadRelayArtifacts({
        cwd,
        deviceId,
        jobId,
        manifestPath: staged.manifestPath,
      })
    } catch (error) {
      execution.result += `\n\nMako could not return a generated file: ${error instanceof Error ? error.message : String(error)}`
    }
    return execution
  } finally {
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
          .object({
            control: z
              .union([
                RelayControlSchema,
                z
                  .literal("stop")
                  .transform(() => RelayControlSchema.parse({ kind: "stop" })),
              ])
              .nullable(),
          })
          .parse(z.json().parse(await response.json())).control
      },
      complete: (completion) => completeRelay(JSON.stringify(completion)),
    },
    {
      control: (lease, control) =>
        options.conversations.control(lease.jobId, control),
      async execute(lease, context) {
        const execution = await executePayload(
          lease.payload,
          options.defaultCwd(),
          context.signal,
          lease.jobId,
          id,
          options.conversations,
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

export async function startSlackRelay(
  options: SlackRelayOptions
): Promise<void> {
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
