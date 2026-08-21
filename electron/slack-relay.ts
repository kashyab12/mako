import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import { backendRelayPost } from "./backend-connection.js"
import {
  resumeNative,
  startFresh,
  waitForNativeRun,
  type FreshOptions,
} from "./drivers.js"
import { harnessProfile } from "./harnesses.js"
import { listThreads, transcriptInlineFor } from "./threads.js"

const HarnessSchema = z.enum(["claude", "codex", "cursor", "grok"])

const SelectionSchema = z.object({
  harness: HarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})

const SlackSchema = z.object({
  channel: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  threadTs: z.string(),
  userId: z.string(),
})

const PayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    selection: SelectionSchema,
    slack: SlackSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("resume"),
    selection: SelectionSchema,
    slack: SlackSchema,
    text: z.string(),
    threadPath: z.string(),
  }),
  z.object({
    kind: z.literal("resume-query"),
    query: z.string(),
    selection: SelectionSchema,
    slack: SlackSchema,
    text: z.string(),
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
let emptyPolls = 0
let stopped = true

async function deviceId(path: string): Promise<string> {
  try {
    return z.uuid().parse((await readFile(path, "utf8")).trim())
  } catch {
    const id = randomUUID()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${id}\n`, { mode: 0o600 })
    return id
  }
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

function tuning(model: string | undefined): FreshOptions {
  return model ? { captureOutput: true, model } : { captureOutput: true }
}

async function executePayload(
  payload: z.infer<typeof PayloadSchema>,
  defaultCwd: string
): Promise<{
  harness: z.infer<typeof HarnessSchema>
  model?: string
  result: string
  threadPath?: string
}> {
  const requested = payload.selection.harness
  const source =
    payload.kind === "resume"
      ? findThread(payload.threadPath)
      : payload.kind === "resume-query"
        ? findThread(payload.query)
        : undefined
  if (payload.kind !== "new" && !source) {
    return {
      harness: requested ?? "codex",
      model: payload.selection.model,
      result: `Mako could not find the local thread \`${payload.kind === "resume" ? payload.threadPath : payload.query}\`. Send \`help\` to see the available commands.`,
    }
  }
  const harness = requested ?? HarnessSchema.parse(source?.harness ?? "codex")
  const profile = await harnessProfile(harness)
  if (!profile.available) {
    return {
      harness,
      result: profile.error ?? `${profile.label} is not available on this Mac.`,
      threadPath: source?.path,
    }
  }
  const requestedModel = payload.selection.model
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
      result: `Mako could not find \`${requestedModel}\` for ${profile.label}. Available models: ${profile.models.map((candidate) => `\`${candidate.id}\``).join(", ")}.`,
      threadPath: source?.path,
    }
  }
  const model = selectedModel?.id
  const launchModel = selectedModel?.launchId ?? selectedModel?.id
  const cwd = source?.cwd ?? defaultCwd
  const before = new Set(listThreads().map((ref) => ref.path))
  const run =
    source && source.harness === harness
      ? await resumeNative(source, payload.text, tuning(launchModel))
      : await startFresh(
          harness,
          cwd,
          source
            ? `${(await transcriptInlineFor(source.path))?.content ?? ""}\n\nContinue this conversation with the user's new message:\n${payload.text}`
            : payload.text,
          tuning(launchModel)
        )
  const completed = await waitForNativeRun(run.path)
  if (completed.state.status !== "done") {
    return {
      harness,
      model,
      result: completed.state.error ?? `${harness} stopped before completing the turn.`,
      threadPath: source?.path,
    }
  }
  const ref =
    source && source.harness === harness
      ? source
      : await waitForFreshThread({ before, cwd, harness })
  return {
    harness,
    model: model ?? ref?.model,
    result: completed.text || `${harness} completed the turn without printable output.`,
    threadPath: ref?.path,
  }
}

async function poll(options: SlackRelayOptions, id: string): Promise<void> {
  if (stopped) return
  try {
    const response = await backendRelayPost(
      "/api/relay/lease",
      JSON.stringify({
        defaultHarness: "codex",
        deviceId: id,
        deviceName: hostname(),
        version: options.version,
        visibilityTimeoutSeconds: 300,
      })
    )
    if (!response.ok) throw new Error(`Relay lease returned ${response.status}`)
    const value = z.json().parse(await response.json())
    const empty = EmptySchema.safeParse(value)
    if (empty.success) emptyPolls = Math.min(emptyPolls + 1, 4)
    if (!empty.success) {
      emptyPolls = 0
      const leased = LeaseSchema.parse(value).lease
      let popReceipt = leased.popReceipt
      let renewal = Promise.resolve()
      const renewTimer = setInterval(() => {
        renewal = renewal.then(async () => {
          const renewed = await backendRelayPost(
            "/api/relay/renew",
            JSON.stringify({
              deviceId: id,
              jobId: leased.jobId,
              messageId: leased.messageId,
              popReceipt,
              visibilityTimeoutSeconds: 300,
            })
          )
          if (!renewed.ok) throw new Error(`Relay renewal returned ${renewed.status}`)
          popReceipt = z
            .object({ popReceipt: z.string().min(1) })
            .parse(z.json().parse(await renewed.json())).popReceipt
        })
      }, 180_000)
      let execution: Awaited<ReturnType<typeof executePayload>>
      try {
        execution = await executePayload(leased.payload, options.defaultCwd())
      } finally {
        clearInterval(renewTimer)
        await renewal
      }
      const completed = await backendRelayPost(
        "/api/relay/complete",
        JSON.stringify({
          deviceId: id,
          harness: execution.harness,
          jobId: leased.jobId,
          messageId: leased.messageId,
          model: execution.model,
          popReceipt,
          result: execution.result,
          threadPath: execution.threadPath,
        })
      )
      if (!completed.ok) {
        throw new Error(`Relay completion returned ${completed.status}`)
      }
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
  if (timer) clearTimeout(timer)
  timer = undefined
}
