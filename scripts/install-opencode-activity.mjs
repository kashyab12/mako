import { build } from 'esbuild'
/** Installs only Mako's own observer file. Existing OpenCode configuration is untouched. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'plugins')
const destination = join(directory, 'mako-activity.js')
const source = resolve('electron/providers/opencode/activity-plugin.ts')
const bundle = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', minify: true, write: false, banner: { js: '// Mako activity observer' } })
const contents = bundle.outputFiles[0].text
if (!contents.includes('Mako activity observer')) throw new Error('Build the OpenCode activity plugin before installing it')
let previous
try { previous = await readFile(destination, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
if (previous && !previous.includes('Mako activity observer')) throw new Error('The destination belongs to another plugin')
await mkdir(directory, { recursive: true })
await writeFile(`${destination}.tmp`, contents)
await rename(`${destination}.tmp`, destination)
process.stdout.write(`Installed ${destination}. Newly started OpenCode 1 sessions report activity to Mako.\n`)
