import { useId, useRef, useState } from "react"
import { CHECK_NAMES, STEP_OF, type VerificationReport } from "@verifier"
import { Button } from "@/components/ui/button"
import { EXAMPLE_TEXT } from "./example"
import { checkProof } from "./proof"
import { CHECK_WORDS, verdictOf } from "./verdict"
import { CHECK_LABELS, FAIL_WORDS } from "./words"

export function App() {
  const [text, setText] = useState("")
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [running, setRunning] = useState(false)
  const verdictRef = useRef<HTMLDivElement>(null)
  const fieldId = useId()

  async function run(proof: string) {
    setRunning(true)
    const result = await checkProof(proof)
    setReport(result)
    setRunning(false)
    verdictRef.current?.focus()
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Check an open yourself</h1>
        <p>
          When you open a box, our server picks your item. This page lets you repeat that pick on your own
          device, with the same numbers, and see if you get the same answer.
        </p>
        <p>
          Nothing on this page asks our server whether the open was fair. You can turn your internet off now
          and it still works.
        </p>
        <p>Read "What this does not prove" below. It is short, and it matters.</p>
      </header>

      <section aria-labelledby={`${fieldId}-label`} className="space-y-3">
        <label id={`${fieldId}-label`} htmlFor={fieldId} className="block font-medium">
          Paste a proof
        </label>
        <textarea
          id={fieldId}
          value={text}
          onChange={(event) => {
            // A result is only ever shown for the text it was computed from.
            setText(event.target.value)
            setReport(null)
          }}
          rows={10}
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run(text)} disabled={running || text.trim() === ""}>
            Check
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setText(EXAMPLE_TEXT)
              void run(EXAMPLE_TEXT)
            }}
            disabled={running}
          >
            Try the example
          </Button>
        </div>
      </section>

      <div ref={verdictRef} tabIndex={-1} role="status" aria-live="polite" className="outline-none">
        {running ? <p>Computing in your browser…</p> : report ? <Verdict report={report} /> : null}
      </div>

      {report ? <Checks report={report} /> : null}

      <section aria-labelledby="not-proven" className="space-y-3">
        <h2 id="not-proven" className="text-lg font-semibold">
          What this does not prove
        </h2>
        <p>
          This page checks four things: the secret we revealed matches the fingerprint our server published;
          the chances match the fingerprint recorded on your open; the pick, redone from the secret, the
          client seed and the counter, gives the number we recorded; and that number lands on the item
          recorded for your win.
        </p>
        <p>
          You were not shown the fingerprint or the client seed before you played. Our server created both,
          and this page reads both from our server. When our server creates a fingerprint for a player, it
          writes a record in its audit log. This page does not check that record.
        </p>
        <p>So this page cannot prove, on its own, that we did not choose the secret after your open.</p>
        <p>It also cannot prove that the item was in stock or that it was sent to you.</p>
        <p>
          You received this page from us. If you do not trust the copy we serve, open the copy on GitHub
          Pages, or download the code and run it yourself. That does not remove us from the picture
          completely: we wrote the code, and you still have to read it or trust someone who did.
        </p>
      </section>
    </main>
  )
}

function Verdict({ report }: { report: VerificationReport }) {
  const { word, line } = verdictOf(report)
  const tone =
    report.status === "verified" ? "text-ok" : report.status === "failed" ? "text-fail" : "text-pending"
  return (
    <div className="space-y-1" data-status={report.status}>
      <p className={`text-3xl font-bold ${tone}`}>{word}</p>
      <p>{line}</p>
    </div>
  )
}

function Checks({ report }: { report: VerificationReport }) {
  return (
    <ol className="space-y-2" aria-label="The checks">
      {CHECK_NAMES.map((name) => {
        const check = report.checks[name]
        const skipped = report.notRun.find((n) => n.check === name)
        const state = check ? (check.ok ? "matches" : "does not match") : `not run: ${skipped?.reason ?? "no reason given"}`
        // The sentence follows the result: a mismatch never sits next to the words of a match.
        const sentence = check ? (check.ok ? CHECK_WORDS[name] : FAIL_WORDS[name]) : null
        return (
          <li key={name} data-check={name} data-state={check ? (check.ok ? "match" : "mismatch") : "not-run"}>
            <span className="font-medium">
              Step {STEP_OF[name]}. {CHECK_LABELS[name]}:
            </span>{" "}
            <span className="font-semibold">{state}</span>
            {sentence ? `. ${sentence}` : null}
          </li>
        )
      })}
    </ol>
  )
}
