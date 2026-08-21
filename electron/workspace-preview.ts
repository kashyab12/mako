export function workspacePreviewPath(requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== "mako-file:" || url.host !== "workspace") return null
  const encoded = url.pathname.slice(1).split("/")
  const parts: string[] = []
  try {
    for (const value of encoded) {
      const part = decodeURIComponent(value)
      if (
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\\") ||
        part.includes("\0")
      ) {
        return null
      }
      parts.push(part)
    }
  } catch {
    return null
  }
  return parts.join("/")
}
