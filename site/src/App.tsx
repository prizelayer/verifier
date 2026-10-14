import { useEffect, useId, useRef, useState } from "react"
import type { VerificationReport } from "@verifier"
import { Button } from "@/components/ui/button"
import { EXAMPLE_TEXT } from "./example"
import { checkProof, type Checked } from "./proof"
import { StepCards } from "./steps"
import { COULD_NOT_FINISH, STEPS } from "./words"
import { caveatOf, verdictOf } from "./verdict"

export function App() {
  const [text, setText] = useState("")
  const [checked, setChecked] = useState<Checked | null>(null)
  const [running, setRunning] = useState(false)
  const verdictRef = useRef<HTMLDivElement>(null)
  // The text on screen now, read when a check finishes: a result is kept only for the text it checked.
  const current = useRef("")
  const fieldId = useId()
  const report = checked?.kind === "report" ? checked.report : null
  const input = checked?.kind === "report" ? checked.input : null

  function edit(value: string) {
    current.current = value
    setText(value)
    setChecked(null)
  }

  async function run(proof: string) {
    setRunning(true)
    let result: Checked
    try {
      result = await checkProof(proof)
    } catch {
      // checkProof is built not to throw; if it ever does, the reader gets a sentence, not a page
      // stuck at "Computing".
      result = { kind: "notAProof", message: COULD_NOT_FINISH }
    } finally {
      setRunning(false)
    }
    if (proof !== current.current) return
    setChecked(result)
    verdictRef.current?.focus()
  }

  // The failing card is scrolled to; the focus stays on the verdict, which a screen reader reads first.
  const failingStep = report?.firstFailure?.step
  useEffect(() => {
    if (failingStep !== undefined) document.querySelector(`[data-step="${failingStep}"]`)?.scrollIntoView?.({ block: "nearest" })
  }, [failingStep, checked])

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
          onChange={(event) => edit(event.target.value)}
          readOnly={running}
          rows={10}
          spellCheck={false}
          aria-describedby={checked?.kind === "notAProof" ? `${fieldId}-problem` : undefined}
          className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
        />
        {checked?.kind === "notAProof" ? (
          <p id={`${fieldId}-problem`} className="text-fail">
            {checked.message}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run(text)} disabled={running || text.trim() === ""}>
            Check
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              edit(EXAMPLE_TEXT)
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

      {report && input ? <StepCards report={report} input={input} /> : report ? null : <EmptySteps />}

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
  const caveat = caveatOf(report)
  const tone =
    report.status === "verified" ? "text-ok" : report.status === "failed" ? "text-fail" : "text-pending"
  return (
    <div className="space-y-1" data-status={report.status}>
      <p className={`text-3xl font-bold ${tone}`}>{word}</p>
      <p>{line}</p>
      {caveat ? <p data-caveat="yes">{caveat}</p> : null}
    </div>
  )
}

/** Before any check: the four steps, greyed, with their explanations readable. */
function EmptySteps() {
  return (
    <div className="space-y-6 text-muted-foreground" aria-label="The four steps">
      {STEPS.map(({ step, title, text }) => (
        <section key={step} aria-labelledby={`step-${step}`} data-step={step} className="space-y-2 rounded-lg border border-border p-4">
          <h2 id={`step-${step}`} className="text-lg font-semibold">
            Step {step} — {title}
          </h2>
          {text.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </div>
  )
}
