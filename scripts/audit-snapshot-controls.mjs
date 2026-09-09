/** Read-only GitHub evidence for snapshot/rewind and browser/computer-control work. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const exec = promisify(execFile)
const destination = process.argv[2] ?? "/tmp/mako-snapshot-controls-evidence"
const repositories = [
  "pingdotgg/t3code",
  "stablyai/orca",
  "hardbeat920/monocode",
]
const topics = [
  "snapshot",
  "checkpoint",
  "rewind",
  "rollback",
  "browser",
  '"computer use"',
]
await mkdir(destination, { recursive: true })
for (const repository of repositories) {
  const queries = []
  const records = new Map()
  for (const topic of topics) {
    const query = `repo:${repository} ${topic} in:title`
    let total = 0
    let received = 0
    for (let page = 1; page <= 10; page++) {
      const { stdout } = await exec(
        "gh",
        [
          "api",
          "--method",
          "GET",
          "search/issues",
          "-f",
          `q=${query}`,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ],
        { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }
      )
      const response = JSON.parse(stdout)
      total = response.total_count
      received += response.items.length
      for (const issue of response.items)
        records.set(issue.number, {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          kind: issue.pull_request ? "pull-request" : "issue",
          state: issue.state,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
          body: issue.body,
          comments: issue.comments,
        })
      if (received >= total || response.items.length < 100) break
    }
    queries.push({ query, total, received, truncated: received < total })
  }
  await writeFile(
    join(destination, `${repository.replace("/", "-")}.json`),
    JSON.stringify(
      {
        repository,
        checkedAt: new Date().toISOString(),
        queries,
        records: [...records.values()].sort((a, b) => b.number - a.number),
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    `${repository}: ${records.size} distinct issues/PRs across ${queries.length} queries; ${queries.filter((query) => query.truncated).length} truncated queries`
  )
}
