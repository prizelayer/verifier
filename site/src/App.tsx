import { useEffect, useId, useRef, useState } from "react"
import type { UpgradeStepReport, VerificationInput, VerificationReport } from "@verifier"
import { Button } from "@/components/ui/button"
import { EXAMPLE_TEXT } from "./example"
import { LookupBox } from "./LookupBox"
import { checkProof, type Checked } from "./proof"
import { SourceLine, StepCards } from "./steps"
import { UpgradeStepCards } from "./upgradeSteps"
import { COULD_NOT_FINISH, FIRST_VISIT, NOT_PROVEN_SEEDS, PROOF_EXPLAINED, STEP_PROOF_EXPLAINED, STEPS, UPGRADE_STEP_OF, UPGRADE_WIN, type UpgradeStepName } from "./words"
import { caveatOf, stepVerdictOf, verdictOf } from "./verdict"

export function App({ fetchFn }: { fetchFn?: typeof fetch } = {}) {
  const [text, setText] = useState("")
  const [checked, setChecked] = useState<Checked | null>(null)
  const [running, setRunning] = useState(false)
  // A lookup in flight: the box and its buttons wait, so the answer cannot land over a pasted proof.
  const [lookingUp, setLookingUp] = useState(false)
  const verdictRef = useRef<HTMLDivElement>(null)
  // The text on screen now, read when a check finishes: a result is kept only for the text it checked.
  const current = useRef("")
  const fieldId = useId()
  const report = checked?.kind === "report" ? checked.report : null
  const input = checked?.kind === "report" ? checked.input : null
  const stepReport = checked?.kind === "stepReport" ? checked.report : null
  const stepInput = checked?.kind === "stepReport" ? checked.input : null
  // A new address (the link from an upgraded win to its step) starts the lookup box again, so it reads it.
  // Only a really different address does: a late event for the address the box already read would
  // replace the box under the reader's hand.
  const [address, setAddress] = useState(() => window.location.hash)
  useEffect(() => {
    const changed = () => setAddress(window.location.hash)
    window.addEventListener("hashchange", changed)
    return () => window.removeEventListener("hashchange", changed)
  }, [])

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
  const stepFailure = stepReport?.firstFailure?.check as UpgradeStepName | undefined
  const failingStep = report?.firstFailure?.step ?? (stepFailure === undefined ? undefined : UPGRADE_STEP_OF[stepFailure])
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
          Nothing on this page asks our server whether the open was fair. Once the proof is in the field, you
          can turn your internet off and the check still works.
        </p>
        <p>Read "What this does not prove" below. It is short, and it matters.</p>
      </header>

      <section aria-labelledby="first-visit" data-first-visit className="space-y-3">
        <h2 id="first-visit" className="text-lg font-semibold">
          {FIRST_VISIT.heading}
        </h2>
        <p>{FIRST_VISIT.link}</p>
        <p>{FIRST_VISIT.noTyping}</p>
        <p>{FIRST_VISIT.pending}</p>
      </section>

      <LookupBox
        key={address}
        disabled={running}
        shownText={text}
        onBusy={setLookingUp}
        fetchFn={fetchFn}
        onFound={(found) => {
          edit(found)
          void run(found)
        }}
      />

      <section aria-labelledby={`${fieldId}-label`} aria-busy={lookingUp} className="space-y-3">
        <label id={`${fieldId}-label`} htmlFor={fieldId} className="block font-medium">
          Paste a proof
        </label>
        <p id={`${fieldId}-what`} className="text-sm text-muted-foreground">
          {PROOF_EXPLAINED} {STEP_PROOF_EXPLAINED}
        </p>
        <textarea
          id={fieldId}
          value={text}
          onChange={(event) => edit(event.target.value)}
          readOnly={running || lookingUp}
          rows={10}
          spellCheck={false}
          aria-describedby={checked?.kind === "notAProof" ? `${fieldId}-what ${fieldId}-problem` : `${fieldId}-what`}
          className="w-full rounded-lg border border-input bg-background p-3 font-mono text-xs"
        />
        {checked?.kind === "notAProof" ? (
          <p id={`${fieldId}-problem`} className="text-fail">
            {checked.message}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run(text)} disabled={running || lookingUp || text.trim() === ""}>
            Check
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              edit(EXAMPLE_TEXT)
              void run(EXAMPLE_TEXT)
            }}
            disabled={running || lookingUp}
          >
            Try the example
          </Button>
        </div>
      </section>

      <div ref={verdictRef} tabIndex={-1} role="status" aria-live="polite" className="outline-none">
        {running ? (
          <p>Computing in your browser…</p>
        ) : report ? (
          <Verdict report={report} input={input} />
        ) : stepReport ? (
          <StepVerdict report={stepReport} />
        ) : null}
      </div>

      {report && input ? (
        <StepCards report={report} input={input} />
      ) : stepReport && stepInput ? (
        <UpgradeStepCards report={stepReport} input={stepInput} />
      ) : report || stepReport ? null : (
        <EmptySteps />
      )}

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
        <p>{NOT_PROVEN_SEEDS}</p>
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

function Verdict({ report, input }: { report: VerificationReport; input: VerificationInput | null }) {
  const { word, line } = verdictOf(report)
  const caveat = caveatOf(report)
  const stepId = input?.gameKind === "upgrade" ? input.expected.upgradeStepId : undefined
  const tone =
    // Pending is not a warning: it is neutral ink, never the colour of a pass or a fail.
    report.status === "verified" ? "text-ok" : report.status === "failed" ? "text-fail" : "text-muted-foreground"
  return (
    <div className="space-y-1" data-status={report.status}>
      <p className={`text-3xl font-bold ${tone}`}>{word}</p>
      <p>{line}</p>
      {caveat ? <p data-caveat="yes">{caveat}</p> : null}
      {stepId !== undefined ? (
        <p data-upgrade-win>
          {UPGRADE_WIN.note} <a href={`#step=${encodeURIComponent(stepId)}`} className="underline">{UPGRADE_WIN.link}</a>.
        </p>
      ) : null}
    </div>
  )
}

/** The verdict of an upgrade step: the same words and colours as an open's, never a celebration. */
function StepVerdict({ report }: { report: UpgradeStepReport }) {
  const { word, line } = stepVerdictOf(report)
  const tone = report.status === "verified" ? "text-ok" : report.status === "failed" ? "text-fail" : "text-muted-foreground"
  return (
    <div className="space-y-1" data-status={report.status} data-outcome={report.trace.computedOutcome ?? "none"}>
      <p className={`text-3xl font-bold ${tone}`}>{word}</p>
      <p>{line}</p>
    </div>
  )
}

/** Before any check: the four steps, greyed, with their explanations readable. */
function EmptySteps() {
  return (
    <div className="space-y-6 text-muted-foreground" aria-label="The four steps">
      {STEPS.map(({ step, title, text, source }) => (
        <section key={step} aria-labelledby={`step-${step}`} data-step={step} className="space-y-2 rounded-lg border border-border p-4">
          <h2 id={`step-${step}`} className="text-lg font-semibold">
            Step {step} — {title}
          </h2>
          <SourceLine source={source} />
          {text.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </div>
  )
}
