/**
 * Find native sessions that Mako's own tests and probes left in the real
 * provider stores, and remove them through their providers.
 *
 *   npx tsx scripts/clean-fixture-sessions.ts            # list only
 *   npx tsx scripts/clean-fixture-sessions.ts --delete   # remove them
 *
 * A fixture session is one whose working directory is a disposable directory
 * that a Mako test or probe creates under the OS temporary directory, named
 * with one of the prefixes below. Nothing else qualifies. macOS keeps those
 * directories around, so their presence says nothing; a fixture updated in
 * the last thirty minutes is treated as a run in progress and left alone.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCatalog } from "@mako/sessions"
import type { ThreadRef } from "@mako/sessions"

const FIXTURE_DIRECTORY = /\/(?:mako-provider-e2e|mako-e2e|mako-rewind-e2e|acp-perm|acp-steer|acp-steer-tools|acp-probe|mako-workspace-ui|mako-live-test|mako-codex-large|mako-catalog-growth|mako-catalog-remove|codex-home|codex-steer)-[^/]+(?:\/|$)/

function fixtureRoot(ref: ThreadRef): boolean {
  const cwd = ref.cwd ?? ""
  const temporary = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  return temporary.some((root) => cwd.startsWith(root)) && FIXTURE_DIRECTORY.test(cwd)
}

const IN_PROGRESS_MS = 30 * 60_000
const remove = process.argv.includes("--delete")
const scratch = await mkdtemp(join(tmpdir(), "mako-clean-fixtures-"))
const catalog = defaultCatalog({ cachePath: join(scratch, "cache.json") })
try {
  const refs = await catalog.scan()
  const fixtures = refs.filter(fixtureRoot)
  const recent = (ref: ThreadRef) => Date.now() - Date.parse(ref.updatedAt ?? "") < IN_PROGRESS_MS
  const live = fixtures.filter(recent)
  const stale = fixtures.filter((ref) => !recent(ref))
  const byHarness = new Map<string, number>()
  for (const ref of stale) byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
  console.log(`${stale.length} fixture sessions (${[...byHarness].map(([harness, count]) => `${harness} ${count}`).join(", ") || "none"}); ${live.length} updated in the last 30 minutes (kept)`)
  for (const ref of stale) console.log(`  ${ref.harness}  ${(ref.updatedAt ?? "").slice(0, 16)}  ${(ref.title ?? "untitled").slice(0, 40).padEnd(40)}  ${ref.cwd}`)
  if (!remove) {
    if (stale.length) console.log("Dry run. Add --delete to remove these through their providers.")
  } else {
    let removed = 0
    const unsupported: string[] = []
    for (const ref of stale) {
      if (await catalog.remove(ref.path)) removed += 1
      else unsupported.push(`${ref.harness}: ${ref.path}`)
    }
    console.log(`Removed ${removed} of ${stale.length}.`)
    for (const entry of unsupported) console.log(`  no removable form: ${entry}`)
  }
} finally {
  await catalog.stop()
  await rm(scratch, { recursive: true, force: true })
}
