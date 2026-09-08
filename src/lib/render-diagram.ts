import mermaid from "mermaid"

const style = getComputedStyle(document.documentElement)
// Mermaid's theme arithmetic does not accept CSS Color 4 (our tokens use OKLCH).
// Let the browser resolve them into sRGB before passing them to Mermaid.
function themeColor(token: string): string {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d")!
  context.fillStyle = style.getPropertyValue(token).trim()
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`
}
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  htmlLabels: false,
  theme: "base",
  themeVariables: {
    fontFamily: style.fontFamily,
    primaryColor: themeColor("--raised"),
    primaryTextColor: themeColor("--foreground"),
    primaryBorderColor: themeColor("--border"),
    lineColor: themeColor("--muted-foreground"),
    background: themeColor("--surface"),
  },
})

export async function renderDiagram(source: string): Promise<string> {
  const { svg } = await mermaid.render(`diagram-${crypto.randomUUID()}`, source)
  // Percentage dimensions have no intrinsic size when an SVG is an image source.
  const document = new DOMParser().parseFromString(svg, "image/svg+xml")
  const root = document.documentElement
  const viewBox = root.getAttribute("viewBox")?.split(/\s+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    root.setAttribute("width", String(viewBox[2]))
    root.setAttribute("height", String(viewBox[3]))
  }
  return new XMLSerializer().serializeToString(root)
}
