import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void checkElectron()
} else {
  await buildAndCheck()
}

async function buildAndCheck() {
  const { build, preview } = await import("vite")
  const directory = await mkdtemp(join(tmpdir(), "mako-renderer-assets-"))
  let server
  try {
    const outDir = join(directory, "dist")
    await build({
      logLevel: "error",
      build: {
        outDir,
        rollupOptions: { input: resolve("scripts/renderer-assets.html") },
      },
    })
    server = await preview({
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0 },
    })
    const url = server.resolvedUrls.local[0]
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "mako-renderer-assets", main: fileURLToPath(import.meta.url) })
    )
    const environment = { ...process.env, MAKO_ASSET_TEST_ROOT: directory, MAKO_ASSET_TEST_URL: url }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(resolve("node_modules/.bin/electron"), [directory], {
      stdio: "inherit",
      env: environment,
    })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server?.httpServer.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function checkElectron() {
  const { app, BrowserWindow } = await import("electron")
  const directory = process.env.MAKO_ASSET_TEST_ROOT
  app.setPath("userData", join(directory, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  try {
    for (const protocol of ["http", "file"]) {
      if (protocol === "http")
        await window.loadURL(`${process.env.MAKO_ASSET_TEST_URL}scripts/renderer-assets.html`)
      else
        await window.loadFile(join(directory, "dist/scripts/renderer-assets.html"))
      const result = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (document.images.length < 3 && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        const images = await Promise.all([...document.images].map(async image => {
          await image.decode().catch(() => {});
          return { src: image.src, width: image.naturalWidth, height: image.naturalHeight };
        }));
        const masks = await Promise.all(['.ocean-grain', '.ocean-fin', '.ocean-fin-glint'].map(async selector => {
          const element = document.querySelector(selector);
          const maskUrl = getComputedStyle(element).maskImage.match(/url\\(["']?([^"')]+)/)[1];
          const mask = new Image();
          mask.src = maskUrl;
          await mask.decode().catch(() => {});
          return { selector, width: mask.naturalWidth };
        }));
        return { images, masks };
      })()`)
      assert.equal(result.images.length, 3, "Both ocean images and the About icon must mount")
      for (const image of result.images)
        assert.ok(image.width > 0 && image.height > 0, `${protocol}: asset failed to load: ${image.src}`)
      for (const mask of result.masks)
        assert.ok(mask.width > 0, `${protocol}: ${mask.selector} mask failed to load`)
      console.log(`${protocol}: ocean artwork, reflection, About icon and all CSS animation masks load`)
    }
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
