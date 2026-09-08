import { build } from "esbuild"
import { mkdir, copyFile } from "node:fs/promises"

await mkdir("dist-browser-extension", { recursive: true })
await build({
  entryPoints: ["browser-extension/background.ts", "browser-extension/popup.ts"],
  outdir: "dist-browser-extension", bundle: true, format: "esm", platform: "browser", target: "chrome125", minify: true,
})
for (const file of ["manifest.json", "popup.html", "popup.css"])
  await copyFile(`browser-extension/${file}`, `dist-browser-extension/${file}`)
console.log("Built Mako Browser extension in dist-browser-extension")
