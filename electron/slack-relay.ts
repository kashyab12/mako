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
import { harnessProfile, resolveHarnessTuning } from "./harnesses.js"
import type { HarnessModelOption } from "./shared.js"
import { listThreads, transcriptInlineFor } from "./threads.js"

const HarnessSchema = z.enum(["claude", "codex", "cursor", "grok"])

const SelectionSchema = z.object({
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
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
  z.object({
    kind: z.literal("inspect-threads"),
    query: z.string().optional(),
    selection: SelectionSchema,
    slack: SlackSchema,
  }),
  z.object({
    kind: z.literal("inspect-models"),
    selection: SelectionSchema,
    slack: SlackSchema,
  }),
  z.object({
    kind: z.literal("configure"),
    selection: SelectionSchema,
    slack: SlackSchema,
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

async function executePayload(
  payload: z.infer<typeof PayloadSchema>,
  defaultCwd: string
): Promise<{
  effort?: string
  fast?: boolean
  harness: z.infer<typeof HarnessSchema>
  model?: string
  result: string
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
  if (fast !== undefined && harness === "claude") {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: "Claude Code print mode does not currently expose its fast-mode control. Reasoning and model selection still work.",
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
  const text = payload.text
  const cwd = source?.cwd ?? defaultCwd
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
  const completed = await waitForNativeRun(run.path)
  if (completed.state.status !== "done") {
    return {
      effort,
      fast,
      harness,
      model,
      result: completed.state.error ?? `${harness} stopped before completing the turn.`,
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
          effort: execution.effort,
          fast: execution.fast,
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
