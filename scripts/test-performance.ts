import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import {
  buildWorkspaceTree,
  pathToOpenKeys,
} from "../src/lib/workspace-tree.ts"
import type { WorkspaceFile } from "../electron/shared.ts"

const files: WorkspaceFile[] = Array.from({ length: 20_000 }, (_, index) => ({
  path: `packages/package-${Math.floor(index / 200)}/src/features/feature-${index}/index.ts`,
  size: 1,
}))
const target = "packages/package-42/src/features/feature-8500/index.ts"
const started = performance.now()
const keys = pathToOpenKeys(files, target)
const duration = performance.now() - started
assert.deepEqual(keys, [
  "packages",
  "packages/package-42/src/features",
  "packages/package-42/src/features/feature-8500",
])
assert.ok(duration < 500, `path reveal took ${duration.toFixed(1)}ms`)

const rows = buildWorkspaceTree(files, new Set(keys))
assert.equal(
  rows.some((row) => row.kind === "file" && row.path === target),
  true
)
console.log(`workspace reveal over 20,000 files passed in ${duration.toFixed(1)}ms`)
