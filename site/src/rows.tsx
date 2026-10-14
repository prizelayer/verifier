import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { FIRST_ROWS, moreRows, SLOW_DRAW_ROWS, skippedRows } from "./words"

/**
 * The body rows of a long table: the first {@link FIRST_ROWS}, plus any row `keep` names, then one
 * line that says how many are left and a button that draws them all. Where the cut skips rows
 * before a kept row, a marker row says which, so the table never looks continuous when it is not.
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
  // The button sits in a row that goes away once every row is drawn: the focus moves to the table.
  const table = useRef<HTMLTableElement | null>(null)
  useEffect(() => {
    if (all && table.current) {
      table.current.tabIndex = -1
      table.current.focus()
    }
  }, [all])
  const shown = all ? rows.map((item, index) => ({ item, index })) : firstRows(rows, keep)
  const left = rows.length - shown.length
  return (
    <>
      {shown.map(({ item, index }, at) => {
        const previous = at === 0 ? -1 : shown[at - 1].index
        return (
          <Fragment key={index}>
            {index > previous + 1 ? (
              <tr data-skipped-rows={`${previous + 1}-${index - 1}`}>
                <td colSpan={columns} className="py-1 text-muted-foreground">
                  {skippedRows(previous + 1, index - 1)}
                </td>
              </tr>
            ) : null}
            {row(item, index)}
          </Fragment>
        )
      })}
      {left > 0 ? (
        <tr data-more-rows={left}>
          <td colSpan={columns} className="py-2">
            <span className="block">{moreRows(left)}</span>
            <Button
              variant="outline"
              className="mt-2"
              onClick={(event) => {
                table.current = event.currentTarget.closest("table")
                setAll(true)
              }}
            >
              Draw all {rows.length.toLocaleString("en")} rows
              {rows.length > SLOW_DRAW_ROWS ? " (this can take a few seconds)" : ""}
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
