import { getMako } from "@/lib/bridge"

/** Read through the owning conversation, without opening or changing a workbench tab. */
export async function readTranscriptMedia({
  path,
  threadPath,
  liveId,
}: {
  path: string
  threadPath?: string
  liveId?: string
}): Promise<{ url: string; mimeType: string }> {
  const bridge = getMako()
  const file = liveId
    ? await bridge.readLiveFile(liveId, path)
    : threadPath
      ? await bridge.readThreadFile(threadPath, path)
      : await bridge.readFile(path)
  if (!file.previewUrl || !file.mimeType)
    throw new Error("This file has no media preview")
  return {
    url: bridge.resolveFileUrl(file.previewUrl),
    mimeType: file.mimeType,
  }
}
