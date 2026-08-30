import { z } from "zod"
import { downloadSlackFile } from "../../../../src/integrations/slack/client"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"

const RequestSchema = z.object({
  attachmentId: z.string().min(1).max(160),
  deviceId: z.uuid(),
  jobId: z.uuid(),
})

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const input = RequestSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, input.deviceId)) return relayUnauthorized()
  const attachment = await azureRelayStore.attachment(input)
  const file = await downloadSlackFile(attachment.id)
  const name = file.name.replace(/[\p{Cc}"\\;]/gu, "_")
  const body = new ArrayBuffer(file.bytes.byteLength)
  new Uint8Array(body).set(file.bytes)
  return new Response(body, {
    headers: {
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": file.bytes.byteLength.toString(),
      "Content-Type": file.mimeType,
      "X-Mako-Attachment-Name": encodeURIComponent(name),
    },
  })
}
