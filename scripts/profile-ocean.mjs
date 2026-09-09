import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) void profileElectron()
else await buildAndProfile()

async function buildAndProfile() {
  const { build } = await import("vite")
  const directory = await mkdtemp(join(tmpdir(), "mako-ocean-profile-"))
  try {
    const baseline = process.argv[3]
    const files = ["src/index.css", "src/components/ui/ocean-scene.tsx", "src/components/ui/ocean-fin.tsx"]
    const sources = new Map(baseline ? files.map(file => [resolve(file), execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" }).replace('src="/artwork/mako-ocean-engraving.webp"', 'src={oceanEngraving}')]) : [])
    const scenePath = resolve(files[1])
    if (sources.has(scenePath) && !sources.get(scenePath).includes("import oceanEngraving")) sources.set(scenePath, 'import oceanEngraving from "/artwork/mako-ocean-engraving.webp?url"\n' + sources.get(scenePath).replaceAll('src="/artwork/mako-ocean-engraving.webp"', 'src={oceanEngraving}'))
    await build({ plugins: [{ name: "ocean-baseline", enforce: "pre", load: id => sources.get(id) }], logLevel: "error", build: { outDir: join(directory, "dist"), rollupOptions: { input: resolve("scripts/ocean-performance.html") } } })
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "mako-ocean-profile", main: fileURLToPath(import.meta.url) }))
    const environment = { ...process.env, MAKO_PROFILE_ROOT: directory, MAKO_PROFILE_OUTPUT: resolve(process.argv[2] ?? "/tmp/mako-ocean-profile.json") }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(resolve("node_modules/.bin/electron"), [directory], { stdio: "inherit", env: environment })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", code => resolve(code ?? 1))
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function profileElectron() {
  const { app, BrowserWindow } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_PROFILE_ROOT, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const debug = window.webContents.debugger
  let trace = []
  let finishTrace

  debug.on("message", (_event, method, params) => {
    if (method === "Tracing.dataCollected") trace.push(...params.value)
    if (method === "Tracing.tracingComplete") finishTrace?.()
  })
  try {
    await window.loadFile(join(process.env.MAKO_PROFILE_ROOT, "dist/scripts/ocean-performance.html"))
    window.show()
    window.focus()
    debug.attach("1.3")
    await debug.sendCommand("Performance.enable")
    await window.webContents.executeJavaScript(`(async () => {
      const deadline=Date.now()+10000;
      while (!document.querySelector('[data-water-moving]') && Date.now()<deadline) await new Promise(r => setTimeout(r, 20));
      if(!document.querySelector('[data-water-moving]')) throw Error("Scene not moving: " + document.hidden + " / " + document.body.innerHTML.slice(0,1000));
      await Promise.all([...document.images].map(i=>i.decode()));
      await document.fonts.ready;
    })()`)
    console.log(await window.webContents.executeJavaScript(`JSON.stringify({scene:document.querySelector(".ocean-scene").getBoundingClientRect().toJSON(), animations:document.querySelector(".ocean-scene").getAnimations({subtree:true}).map(a=>({name:a.animationName,state:a.playState,time:a.currentTime}))})`))
    await writeFile(process.env.MAKO_PROFILE_OUTPUT + ".png", (await window.webContents.capturePage()).toPNG())
    const runs = []
    for (const mode of ["all", "none", "water", "fin", "grain", "all"]) {
      await window.webContents.executeJavaScript(`(() => {
        const mode = ${JSON.stringify(mode)};
        for(const a of document.querySelector('.ocean-scene').getAnimations({subtree:true})) {
          if(a.effect.getTiming().iterations !== Infinity) continue;
          const name = a.animationName;
          const active = mode === 'all' || (mode === 'water' && /^ocean-water/.test(name)) || (mode === 'fin' && name === 'ocean-fin-shimmer') || (mode === 'grain' && name === 'ocean-air');
          if(active) a.play(); else a.pause();
        }
      })()`)
      await new Promise(resolve => setTimeout(resolve, 800))
      if(mode === "all") await writeFile(process.env.MAKO_PROFILE_OUTPUT + ".png", (await window.webContents.capturePage()).toPNG())
      trace = []
      await debug.sendCommand("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" })
      const start = await debug.sendCommand("Performance.getMetrics")
      app.getAppMetrics()
      const frames = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const frames=[]; let previous=performance.now(); const start=previous;
        function tick(now) { frames.push(now-previous); previous=now; if(now-start<3000) requestAnimationFrame(tick); else resolve(frames); }
        requestAnimationFrame(tick);
      })`)
      const end = await debug.sendCommand("Performance.getMetrics")
      const tracingDone = new Promise(resolve => { finishTrace = resolve })
      await debug.sendCommand("Tracing.end")
      await tracingDone
      const traceCounts = Object.fromEntries(["Paint", "PrePaint", "UpdateLayoutTree", "Layout"].map(name => [name, trace.filter(e=>e.name===name).length]))
      const cpu = app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage }))
      const durations = Object.fromEntries(end.metrics.filter(m => /Duration$|LayoutCount|RecalcStyleCount/.test(m.name)).map(m => [m.name, m.value-(start.metrics.find(s=>s.name===m.name)?.value??0)]))
      const interaction = await window.webContents.executeJavaScript(`(async () => {
        const samples=[];
        for(let i=0;i<12;i++) {
          const start=performance.now(); document.querySelector('[data-perf-open]').click();
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          if(!document.querySelector('[data-slot="dialog-content"][data-state="open"]')) throw Error('Settings did not open');
          samples.push(performance.now()-start);
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          await new Promise(r=>setTimeout(r,200));
        }
        return samples;
      })()`)
      const result = { mode, traceCounts, durations, cpu, frames, interaction }
      runs.push(result)
      console.log(JSON.stringify({ mode, traceCounts, taskMs: durations.TaskDuration*1000, cpu, dialogMedianMs: [...interaction].sort((a,b)=>a-b)[6] }))
    }
    await writeFile(process.env.MAKO_PROFILE_OUTPUT, JSON.stringify({ viewport: await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'), runs },null,2))
    app.exit(0)
  } catch(error) { console.error(error); app.exit(1) }
}
