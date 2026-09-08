/** Refresh only the proposals cited by the parity review, without cloning or broad pagination. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFile } from "node:fs/promises"
const exec = promisify(execFile)
const requests = [
  ["stablyai/orca", 14877],
  ["pingdotgg/t3code", 10501],
  ["pingdotgg/t3code", 10401],
  ["pingdotgg/t3code", 10141],
  ["pingdotgg/t3code", 9505],
  ["pingdotgg/t3code", 7302],
  ["omnigent-ai/omnigent", 4647],
  ["omnigent-ai/omnigent", 5854],
]
const results = []
for (const [repository, number] of requests) {
  const { stdout } = await exec(
    "gh",
    ["api", `repos/${repository}/pulls/${number}`],
    { maxBuffer: 512 * 1024, timeout: 15000 }
  )
  const p = JSON.parse(stdout)
  results.push({
    repository,
    number,
    title: p.title,
    url: p.html_url,
    state: p.state,
    mergedAt: p.merged_at,
    branch: p.head.ref,
    sha: p.head.sha,
    updatedAt: p.updated_at,
    checkedAt: new Date().toISOString(),
    body: p.body,
  })
}
const destination = process.argv[2] ?? "/tmp/mako-parity-proposals.json"
await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`)
console.log(
  results
    .map(
      (p) =>
        `${p.repository}#${p.number}: ${p.mergedAt ? "merged" : p.state} ${p.sha}`
    )
    .join("\n")
)
