// Generate the icon sheet gpui-component expects (`icons/<name>.svg`) from the
// Lucide set already vendored for the Electron build, so both front ends draw
// literally the same glyphs. Lucide is ISC-licensed; the notice ships alongside.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const OUT = process.argv[2]
mkdirSync(OUT, { recursive: true })

// gpui-component names a handful of icons after the role they play rather than
// after a Lucide glyph. These are those, mapped to the glyph that plays it.
const ALIAS = {
  'close': 'x',
  'dash': 'minus',
  'window-close': 'x',
  'window-minimize': 'minus',
  'window-maximize': 'square',
  'window-restore': 'copy',
  'resize-corner': 'move-diagonal-2',
  'sort-ascending': 'arrow-up-narrow-wide',
  'sort-descending': 'arrow-down-wide-narrow',
  'inspector': 'inspection-panel',
  'github': 'code-xml',
}

const names = readFileSync(process.argv[3], 'utf8').trim().split('\n')
const missing = []

const svg = (nodes) => {
  const body = nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
  // 1.75 rather than Lucide's default 2: at the 10–12px these are drawn at,
  // a 2px stroke on a 24px grid reads as a blob once it is downsampled.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`
}

for (const name of names) {
  const source = ALIAS[name] ?? name
  try {
    const mod = await import(`file:///Users/kashyab/pi-ui/node_modules/lucide-react/dist/esm/icons/${source}.mjs`)
    writeFileSync(`${OUT}/${name}.svg`, svg(mod.__iconNode))
  } catch (error) {
    missing.push(`${name} (via ${source})`)
  }
}

console.log(`wrote ${names.length - missing.length} icons`)
if (missing.length) console.log('missing:', missing.join(', '))
