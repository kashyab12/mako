import { createHash } from "node:crypto"
import { openAsBlob } from "node:fs"
import {
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises"
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { z } from "zod"
import type { RelayJobPayload } from "@mako/relay"
import {
  backendRelayPost,
  backendRelayUpload,
} from "./backend-connection.js"

export async function stageRelayAttachments(
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
      const declared = Number(
        response.headers.get("content-length") ??
          response.headers.get("x-mako-attachment-size") ??
          "0"
      )
      if (declared > 100 * 1024 * 1024 || total + declared > 200 * 1024 * 1024)
        throw new Error(`${attachment.name} exceeds Mako's attachment limits`)
      if (!response.body)
        throw new Error("Attachment download returned no body")
      const decoded = decodeURIComponent(
        response.headers.get("x-mako-attachment-name") ?? attachment.name
      )
      const name = basename(decoded).replace(/[\p{Cc}\\/:]/gu, "_")
      if (!name || name === "." || name === "..")
        throw new Error("Slack returned an invalid attachment name")
      const prefix = attachment.id.replace(/[^a-zA-Z0-9._-]/g, "_")
      const path = join(attachmentDirectory, `${prefix}-${name}`)
      const file = await open(path, "w", 0o600)
      const reader = response.body.getReader()
      let received = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          received += chunk.value.byteLength
          if (
            received > 100 * 1024 * 1024 ||
            total + received > 200 * 1024 * 1024
          )
            throw new Error("Slack attachments exceed Mako's size limits")
          let offset = 0
          while (offset < chunk.value.byteLength) {
            const written = await file.write(chunk.value, offset)
            offset += written.bytesWritten
          }
        }
      } catch (error) {
        await file.close()
        await rm(path, { force: true })
        throw error
      }
      await file.close()
      total += received
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

export function relayPrompt(
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

export async function uploadRelayArtifacts({
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
    const source = await openAsBlob(path, {
      type: "application/octet-stream",
    })
    const artifactKey = createHash("sha256")
      .update(local)
      .digest("hex")
      .slice(0, 32)
    const response = await backendRelayUpload(
      "/api/relay/artifact",
      source,
      {
        artifactKey,
        deviceId,
        filename: basename(path),
        jobId,
        mimeType: "application/octet-stream",
      }
    )
    if (!response.ok)
      throw new Error(`Relay artifact upload returned ${response.status}`)
  }
}
