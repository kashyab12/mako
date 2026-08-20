import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface BackendSkill {
  id: "mako-operations"
  name: "Mako operations"
  description: string
  uri: "mako://skills/mako-operations"
}

const skills: BackendSkill[] = [
  {
    id: "mako-operations",
    name: "Mako operations",
    description:
      "Coordinate work through Mako, handle Slack requests, choose MCP connections, and gate external actions.",
    uri: "mako://skills/mako-operations",
  },
]

export function listSkills(): BackendSkill[] {
  return skills.map((skill) => ({ ...skill }))
}

export async function readSkill(id: BackendSkill["id"]): Promise<string> {
  return readFile(
    join(process.cwd(), "agent", "skills", id, "SKILL.md"),
    "utf8"
  )
}
