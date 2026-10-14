import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { FIRST_ROWS, moreRows } from "./words"

/**
 * The body rows of a long table: the first {@link FIRST_ROWS}, plus any row `keep` names, then one
 * line that says how many are left and a button that draws them all.
 */
export function Rows<T>({
  rows,
  columns,
  keep,
  row,
}: {
  rows: readonly T[]
  columns: number
  keep?: (item: T) => boolean
  row: (item: T, index: number) => ReactNode
}) {
  const [all, setAll] = useState(false)
  const shown = all ? rows.map((item, index) => ({ item, index })) : firstRows(rows, keep)
  const left = rows.length - shown.length
  return (
    <>
      {shown.map(({ item, index }) => row(item, index))}
      {left > 0 ? (
        <tr data-more-rows={left}>
          <td colSpan={columns} className="py-2">
            <span className="mr-2">{moreRows(left)}</span>
            <Button variant="outline" onClick={() => setAll(true)}>
              Draw all {rows.length.toLocaleString("en")} rows
            </Button>
          </td>
        </tr>
      ) : null}
    </>
  )
}

function firstRows<T>(rows: readonly T[], keep: ((item: T) => boolean) | undefined) {
  const shown: { item: T; index: number }[] = []
  rows.forEach((item, index) => {
    if (index < FIRST_ROWS || keep?.(item)) shown.push({ item, index })
  })
  return shown
}
