const MAX_ROWS = 250
const MAX_COLUMNS = 60

export function TabularPreview({ contents, path }: { contents: string; path: string }) {
  const separator = path.toLowerCase().endsWith(".tsv") ? "\t" : ","
  const { rows, truncated } = parseTable(contents, separator)
  const header = rows[0] ?? []
  const body = rows.slice(1)

  if (rows.length === 0) {
    return <p className="p-5 text-ui text-faint">This table is empty.</p>
  }

  return (
    <div className="min-h-full overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-label">
        <thead className="sticky top-0 z-10 bg-raised">
          <tr>
            <th className="sticky left-0 z-20 border-r border-b border-hairline bg-raised px-2 py-1.5 text-right font-normal text-faint">
              #
            </th>
            {header.map((cell, index) => (
              <th
                key={index}
                className="max-w-72 border-r border-b border-hairline px-2 py-1.5 text-left font-medium text-foreground"
              >
                <span className="block truncate">{cell || `Column ${index + 1}`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-fill-hover">
              <td className="sticky left-0 border-r border-b border-hairline bg-surface px-2 py-1.5 text-right text-faint">
                {rowIndex + 1}
              </td>
              {header.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-72 border-r border-b border-hairline px-2 py-1.5 text-foreground/85"
                  title={row[columnIndex]}
                >
                  <span className="block truncate">{row[columnIndex] ?? ""}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="sticky bottom-0 border-t border-hairline bg-surface/95 px-3 py-2 text-label text-faint">
          Preview limited to {MAX_ROWS} rows and {MAX_COLUMNS} columns.
        </p>
      ) : null}
    </div>
  )
}

function parseTable(contents: string, separator: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let index = 0
  let truncated = false

  const pushField = () => {
    if (row.length < MAX_COLUMNS) row.push(field)
    else truncated = true
    field = ""
  }
  const pushRow = () => {
    pushField()
    if (rows.length < MAX_ROWS) rows.push(row)
    else truncated = true
    row = []
  }

  while (index < contents.length && rows.length < MAX_ROWS) {
    const character = contents[index]!
    if (character === '"') {
      if (quoted && contents[index + 1] === '"') {
        field += '"'
        index += 2
        continue
      }
      quoted = !quoted
    } else if (character === separator && !quoted) {
      pushField()
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && contents[index + 1] === "\n") index += 1
      pushRow()
    } else {
      field += character
    }
    index += 1
  }
  if (field || row.length > 0) pushRow()
  if (index < contents.length) truncated = true
  return { rows, truncated }
}
