import { ACCEPTANCE_THRESHOLD, PPM_TOTAL, type Check, type ChunkVerdict } from "@verifier"
import type { ByteGroup } from "./preimage"
import { Rows } from "./rows"

/**
 * One check's two values side by side, and its result. The values and the word come from the
 * library's `Check` only, never from a comparison made here: a view that judged for itself could
 * say "matches" where the library said "does not match". The characters of the second value that
 * differ from the first are marked only when the check failed; the word below carries the meaning.
 */
export function Compare({
  label,
  expectedLabel,
  computedLabel,
  check,
}: {
  label: string
  expectedLabel: string
  computedLabel: string
  check: Check
}) {
  const unusable = check.error !== undefined
  const word = check.ok ? "matches" : unusable ? "cannot be checked" : "does not match"
  return (
    <div className="space-y-1" data-compare={label} data-ok={check.ok ? "yes" : "no"}>
      {/* No recorded value (no item id was given): the empty row is left out, not shown blank. */}
      {check.expected === "" ? null : <Row name={expectedLabel} value={check.expected} />}
      <Row name={computedLabel} value={check.computed} against={check.ok || unusable ? undefined : check.expected} />
      <p className="text-sm font-semibold" data-word>
        {word}
      </p>
    </div>
  )
}

function Row({ name, value, against }: { name: string; value: string; against?: string }) {
  return (
    <div className="text-sm">
      <div className="text-muted-foreground">{name}</div>
      <code className="block break-all font-mono text-xs">
        {against === undefined ? value : <Marked value={value} against={against} />}
      </code>
    </div>
  )
}

function Marked({ value, against }: { value: string; against: string }) {
  const parts: { text: string; differs: boolean }[] = []
  for (let i = 0; i < value.length; i++) {
    const differs = value[i] !== against[i]
    const last = parts[parts.length - 1]
    if (last && last.differs === differs) last.text += value[i]
    else parts.push({ text: value[i], differs })
  }
  return (
    <>
      {parts.map((part, i) =>
        part.differs ? (
          <mark key={i} className="bg-fail/20 text-fail" title="differs">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

export function ByteGroups({ caption, groups }: { caption: string; groups: ByteGroup[] }) {
  return (
    <table className="w-full text-xs">
      <caption className="text-left text-sm text-muted-foreground">{caption}</caption>
      <thead>
        <tr className="text-left">
          <th scope="col">Field</th>
          <th scope="col">Bytes (hex)</th>
          <th scope="col">Means</th>
        </tr>
      </thead>
      <tbody>
        <Rows
          rows={groups}
          columns={3}
          row={(group, i) => (
            <tr key={i} className="align-top">
              <td className="pr-2">{group.name}</td>
              <td className="break-all pr-2 font-mono">{group.hex}</td>
              <td>{group.meaning}</td>
            </tr>
          )}
        />
      </tbody>
    </table>
  )
}

const VERDICT_WORDS: Record<ChunkVerdict["verdict"], string> = {
  accepted: "used",
  rejected: "thrown away",
  "not-reached": "not needed",
}

/**
 * The 4-byte numbers the pick read, each with what the pick did with it. `value` is the library's `v`,
 * shown after the used number; the page does not reduce it itself.
 *
 * The used number's "mod" sum makes the table wider than a 320 px phone, so it scrolls in a frame of its
 * own rather than the page sideways; the frame takes focus, because Safari gives a plain scroll area no
 * keyboard reach. A number never wraps, so none is cut in two.
 */
export function Chunks({ chunks, value }: { chunks: readonly ChunkVerdict[]; value: number | undefined }) {
  return (
    <div role="region" aria-label="The 4-byte numbers" tabIndex={0} data-scroll-frame className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="text-left text-sm text-muted-foreground">
          The 4-byte numbers. A number of {ACCEPTANCE_THRESHOLD.toLocaleString("en")} or more is thrown away.
        </caption>
        <thead>
          <tr className="text-left">
            <th scope="col">Bytes</th>
            <th scope="col">Hex</th>
            <th scope="col">Number</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((c) => (
            <tr key={`${c.attempt}-${c.offset}`} data-chunk={c.verdict}>
              <td>
                {c.attempt > 0 ? `try ${c.attempt + 1}, ` : ""}
                {c.offset}–{c.offset + 3}
              </td>
              <td className="whitespace-nowrap font-mono">{c.chunk.toString(16).padStart(8, "0")}</td>
              <td className="whitespace-nowrap">{c.chunk.toLocaleString("en")}</td>
              <td>
                {VERDICT_WORDS[c.verdict]}
                {c.verdict === "accepted" && value !== undefined
                  ? `: ${c.chunk.toLocaleString("en")} mod ${PPM_TOTAL.toLocaleString("en")} = ${value.toLocaleString("en")}`
                  : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
