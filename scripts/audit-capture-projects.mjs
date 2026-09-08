/** Small read-only inventory: metadata and one latest commit per project. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFile } from "node:fs/promises"
const exec = promisify(execFile)
const projects = [
  "trycua/cua",
  "screenpipe/screenpipe",
  "openclaw/AXorcist",
  "openclaw/Peekaboo",
  "mediar-ai/terminator",
  "hyprcat/mac-cua",
]
async function api(path) {
  const { stdout } = await exec("gh", ["api", path], {
    timeout: 15000,
    maxBuffer: 256 * 1024,
  })
  return JSON.parse(stdout)
}
const result = []
for (const project of projects) {
  try {
    const repo = await api(`repos/${project}`)
    const [commit] = await api(`repos/${project}/commits?per_page=1`)
    result.push({
      repository: repo.full_name,
      url: repo.html_url,
      stars: repo.stargazers_count,
      archived: repo.archived,
      branch: repo.default_branch,
      latestCommit: commit.sha,
      committedAt: commit.commit.committer.date,
      commitUrl: commit.html_url,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    result.push({ repository: project, error: error.message })
  }
}
await writeFile(
  process.argv[2] ?? "/tmp/mako-capture-projects.json",
  `${JSON.stringify(result, null, 2)}\n`
)
console.log(JSON.stringify(result, null, 2))
