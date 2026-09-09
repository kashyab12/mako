import assert from "node:assert/strict"
import { posix, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { listPackage, extractFile } from "@electron/asar"
import ts from "typescript"

export function assertPackagedImports(app) {
  const archive = join(app, "Contents/Resources/app.asar")
  const files = new Set(
    listPackage(archive).map((path) => path.replace(/^\//, ""))
  )
  let checked = 0
  for (const file of files) {
    if (!file.startsWith("dist-electron/") || !file.endsWith(".js")) continue
    const bytes = extractFile(archive, file)
    assert.ok(
      bytes.length <= 2 * 1024 * 1024,
      `Host module exceeds the package check budget: ${file}`
    )
    const source = ts.createSourceFile(
      file,
      bytes.toString("utf8"),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS
    )
    function check(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.startsWith(".")
      ) {
        const target = posix.normalize(
          posix.join(posix.dirname(file), specifier.text)
        )
        assert.ok(
          files.has(target),
          `Packaged import missing: ${file} -> ${specifier.text}`
        )
        checked++
      }
      ts.forEachChild(node, check)
    }
    check(source)
  }
  assert.ok(checked > 0, "The package contains no host imports")
  return checked
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.ok(process.argv[2], "Provide a built Mako.app path")
  console.log(
    `Verified ${assertPackagedImports(resolve(process.argv[2]))} relative imports in the packaged host`
  )
}
