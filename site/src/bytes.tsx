import { ACCEPTANCE_THRESHOLD, PPM_TOTAL, type ChunkVerdict } from "@verifier"
import type { ByteGroup } from "./preimage"

/**
 * Two values side by side, with every character of the second that differs from the first marked.
 * The mark is a `<mark>` and a word, never a colour alone.
 */
export function Compare({
  label,
  expectedLabel,
  computedLabel,
  expected,
  computed,
}: {
  label: string
  expectedLabel: string
  computedLabel: string
  expected: string | undefined
  computed: string | undefined
}) {
  const same = expected !== undefined && expected === computed
  return (
    <div className="space-y-1" data-compare={label} data-same={same ? "yes" : "no"}>
      <Row name={expectedLabel} value={expected} />
      <Row name={computedLabel} value={computed} against={expected} />
      <p className="text-sm font-semibold">
        {expected === undefined || computed === undefined ? "could not be compared" : same ? "matches" : "does not match"}
      </p>
    </div>
  )
}

function Row({ name, value, against }: { name: string; value: string | undefined; against?: string }) {
  return (
    <div className="text-sm">
      <div className="text-muted-foreground">{name}</div>
      <code className="block break-all font-mono text-xs">
        {value === undefined ? "(could not be computed)" : against === undefined ? value : <Marked value={value} against={against} />}
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
        {groups.map((group, i) => (
          <tr key={i} className="align-top">
            <td className="pr-2">{group.name}</td>
            <td className="break-all pr-2 font-mono">{group.hex}</td>
            <td>{group.meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const VERDICT_WORDS: Record<ChunkVerdict["verdict"], string> = {
  accepted: "used",
  rejected: "thrown away",
  "not-reached": "not needed",
}

/** The 4-byte numbers the pick read, each with what the pick did with it. */
export function Chunks({ chunks }: { chunks: readonly ChunkVerdict[] }) {
  return (
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
            <td className="font-mono">{c.chunk.toString(16).padStart(8, "0")}</td>
            <td>{c.chunk.toLocaleString("en")}</td>
            <td>
              {VERDICT_WORDS[c.verdict]}
              {c.verdict === "accepted" ? `: ${c.chunk.toLocaleString("en")} mod ${PPM_TOTAL.toLocaleString("en")} = ${(c.chunk % PPM_TOTAL).toLocaleString("en")}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
