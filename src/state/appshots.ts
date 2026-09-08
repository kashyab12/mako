import { getMako } from "@/lib/bridge"
import type { AttachmentInput } from "@/lib/attachments"
import type { AppshotTarget } from "@/lib/types"

export const appshots = {
  windows: () => getMako().appshotWindows(),
  async capture(target: AppshotTarget): Promise<AttachmentInput[]> {
    const shot = await getMako().captureAppshot(target)
    const binary = atob(shot.image.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index)
    const name = `Appshot ${shot.window.app.replace(/[^a-z0-9 ._-]/gi, "-")}`
    const text = [
      `Appshot of ${shot.window.app}: ${shot.window.title}`,
      `Captured ${new Date(shot.capturedAt).toISOString()}`,
      shot.truncated
        ? "Accessibility text is truncated."
        : "Accessibility text from the captured window.",
      "",
      shot.text,
    ].join("\n")
    return [
      {
        file: new File(
          [bytes],
          `${name}.${shot.image.mimeType === "image/png" ? "png" : "jpg"}`,
          { type: shot.image.mimeType }
        ),
        context: text,
      },
    ]
  },
}
