/** Read-only GitHub inventory. Rerun to refresh dated comparison evidence. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const exec = promisify(execFile)
const repositories = [
  'stablyai/orca', 'hardbeat920/monocode', 'pingdotgg/t3code',
  'omnigent-ai/omnigent', 'Haleclipse/CodexDesktop-Rebuild',
  'ilysenko/codex-desktop-linux', 'anomalyco/opencode',
]
const output = resolve(process.argv[2] ?? '/tmp/mako-reference-audit')
await mkdir(output, { recursive: true })
async function api(endpoint) {
  const { stdout } = await exec('gh', ['api', endpoint], { maxBuffer: 24 * 1024 * 1024 })
  return JSON.parse(stdout)
}
async function pages(endpoint, project) {
  const values = []
  for (let page = 1; page <= 150; page++) {
    const batch = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    values.push(...batch)
    if (batch.length < 100) return { values, complete: true }
  }
  process.stderr.write(`${project}: pagination capped at 15000 entries\n`)
  return { values, complete: false }
}
async function audit(repository) {
  const metadata = await api(`repos/${repository}`)
  const [branches, pulls, issues] = await Promise.all([
    pages(`repos/${repository}/branches`, repository),
    pages(`repos/${repository}/pulls?state=open`, repository),
    pages(`repos/${repository}/issues?state=open`, repository),
  ])
  const relevant = /account|auth|oauth|login|routing|hot.?swap|browser|computer|app.?shot|screenshot|preview|activity|opencode|cursor|devin/i
  const result = {
    fetchedAt: new Date().toISOString(), repository, defaultBranch: metadata.default_branch,
    branches: branches.values.map(({ name, commit }) => ({ name, sha: commit.sha })),
    complete: { branches: branches.complete, pulls: pulls.complete, issues: issues.complete },
    openPulls: pulls.values.map(p => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, sha: p.head.sha, relevant: relevant.test(p.title), body: relevant.test(p.title) ? p.body : undefined })),
    openIssues: issues.values.filter(i => !i.pull_request).map(i => ({ number: i.number, title: i.title, url: i.html_url, relevant: relevant.test(i.title), body: relevant.test(i.title) ? i.body : undefined })),
  }
  await writeFile(resolve(output, `${repository.replace('/', '--')}.json`), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${repository}: ${result.branches.length} branches, ${result.openPulls.length} PRs, ${result.openIssues.length} issues\n`)
}
// Two repositories in flight; preserve partial evidence if GitHub rejects a call.
for (let offset = 0; offset < repositories.length; offset += 2) {
  const results = await Promise.allSettled(repositories.slice(offset, offset + 2).map(audit))
  for (const result of results) if (result.status === 'rejected') { process.stderr.write(`${result.reason}\n`); process.exitCode = 1 }
}
