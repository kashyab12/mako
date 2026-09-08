import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const write = process.argv.includes("--write")
const paths = readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
let violations = 0
for (const path of paths) {
  let text = readFileSync(path, "utf8")
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const edits = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const target = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : node.expression
      const options = node.arguments[1]
      if (
        ts.isIdentifier(target) &&
        target.text === "toast" &&
        options &&
        ts.isObjectLiteralExpression(options)
      ) {
        const properties = options.properties.filter(ts.isPropertyAssignment)
        const named = (name) =>
          properties.find(
            (property) =>
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
              property.name.text === name
          )
        if (named("action")) {
          const duration = named("duration")
          if (
            !duration ||
            duration.initializer.getText(source) !== "Infinity"
          ) {
            violations++
            if (write && !duration) edits.push(options.getStart(source) + 1)
            else
              console.error(
                `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: actionable toasts must remain until dismissed (duration: Infinity)`
              )
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const position of edits.toSorted((a, b) => b - a))
    text = `${text.slice(0, position)}\n          duration: Infinity,${text.slice(position)}`
  if (edits.length) writeFileSync(path, text)
}
if (violations && !write) process.exitCode = 1
else
  console.log(
    write
      ? `Updated ${violations} actionable toasts`
      : "Actionable toasts remain available until dismissed"
  )
