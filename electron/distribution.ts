import { readFileSync } from "node:fs"
import { join } from "node:path"

export type Distribution = "signed" | "unsigned"

export function distributionFromMetadata(contents: string): Distribution {
  return /"makoDistribution"\s*:\s*"signed"/.test(contents)
    ? "signed"
    : "unsigned"
}

export function packagedDistribution(appPath: string): Distribution {
  try {
    return distributionFromMetadata(
      readFileSync(join(appPath, "package.json"), "utf8")
    )
  } catch {
    return "unsigned"
  }
}
