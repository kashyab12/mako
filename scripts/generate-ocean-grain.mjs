import { writeFileSync } from "node:fs"

// Generate the stochastic ink mask once; CSS moves it without runtime drawing.
function grainPath() {
  const dots = []
  for (let y = 0; y < 640; y += 2) {
    for (let x = 0; x < 1280; x += 2) {
      const horizon = 345 + 36 * Math.sin(x / 260)
      const density = 0.2 * Math.exp(-(((y - horizon) / 95) ** 2))
      const sample = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
      if (sample - Math.floor(sample) < density) dots.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  return dots.join("")
}

writeFileSync(
  new URL("../public/artwork/ocean-grain.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640"><path fill="white" d="${grainPath()}"/></svg>\n`
)
