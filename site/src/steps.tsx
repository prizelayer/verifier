import { CHECK_NAMES, STEP_OF, type Check, type CheckName, type VerificationInput, type VerificationReport } from "@verifier"
import { ByteGroups, Chunks, Compare } from "./bytes"
import { editionGroups, snapshotGroups } from "./preimage"
import { CHECK_WORDS } from "./verdict"
import {
  CHECK_LABELS,
  DEPENDENT_NOTE,
  DEPENDS_ON,
  FAIL_WORDS,
  NO_PRIZE_LIST,
  NOT_TOLD_ITEM,
  SEED_LOCKED,
  STEP1_PENDING,
  STEPS,
  type StepNumber,
  unusableWords,
} from "./words"

interface Props {
  report: VerificationReport
  input: VerificationInput
}

/** The four step cards. Every step is drawn, run or not, so a missing value is named, never hidden. */
export function StepCards({ report, input }: Props) {
  const failedNames = CHECK_NAMES.filter((n) => report.checks[n]?.ok === false)
  const failedSteps = new Set(failedNames.map((n) => STEP_OF[n]))
  // A step whose only failures are inputs that could not be used compared nothing: it says so.
  const unusableOnly = (step: StepNumber) =>
    failedNames.filter((n) => STEP_OF[n] === step).every((n) => report.checks[n]?.error !== undefined)
  const pending = input.serverSeedHex === null
  const dependsOnFailed = (step: StepNumber): boolean =>
    DEPENDS_ON[step].some((d) => failedSteps.has(d) || dependsOnFailed(d))

  return (
    <div className="space-y-6">
      {STEPS.map(({ step, title: stepTitle, method, text: stepText }) => {
        const failed = failedSteps.has(step)
        // While the secret is locked, step 1 speaks of no revealed secret and of no comparison made.
        const title = pending && step === 1 ? STEP1_PENDING.title : stepTitle
        const text = pending && step === 1 ? STEP1_PENDING.text : stepText
        // Shown on a failed step too: its own mismatch may only be the echo of the earlier one.
        const dependent = dependsOnFailed(step)
        return (
          <section
            key={step}
            aria-labelledby={`step-${step}`}
            data-step={step}
            data-failed={failed ? "yes" : "no"}
            className={`space-y-3 rounded-lg border p-4 ${failed ? "border-fail" : "border-border"}`}
          >
            <h2 id={`step-${step}`} className="text-lg font-semibold">
              Step {step} — {title}
              {failed ? (
                <span className="ml-2 text-fail" data-header-state>
                  {unusableOnly(step) ? "(cannot be checked)" : "(does not match)"}
                </span>
              ) : null}
            </h2>
            {text.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {dependent ? (
              <p className="font-semibold" data-dependent="yes">
                {DEPENDENT_NOTE}
              </p>
            ) : null}
            <CheckList step={step} report={report} input={input} />
            <StepBytes step={step} report={report} input={input} />
            {method ? <p className="text-xs text-muted-foreground">Method: {method}</p> : null}
          </section>
        )
      })}
    </div>
  )
}

function CheckList({ step, report, input }: Props & { step: StepNumber }) {
  return (
    <ul className="space-y-2" aria-label={`The checks of step ${step}`}>
      {CHECK_NAMES.filter((name) => STEP_OF[name] === step).map((name) => {
        const check = report.checks[name]
        const state = check
          ? check.ok
            ? "matches"
            : check.error !== undefined
              ? "cannot be checked"
              : "does not match"
          : notRunWords(name, report, input)
        // The sentence follows the result: a mismatch never sits next to the words of a match, and an
        // input that cannot be used is named without claiming that a comparison was made.
        const sentence = !check
          ? null
          : check.ok
            ? CHECK_WORDS[name]
            : check.error !== undefined
              ? inputWords(check.field, check.error, input)
              : FAIL_WORDS[name]
        return (
          <li key={name} data-check={name} data-state={check ? (check.ok ? "match" : "mismatch") : "not-run"}>
            <span className="font-medium">{CHECK_LABELS[name]}:</span> <span className="font-semibold">{state}</span>
            {sentence ? `. ${sentence}` : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Why an input could not be used, in a reader's words where the page knows them. */
function inputWords(field: string | undefined, error: string, input: VerificationInput): string {
  const sum = input.edition.slots.reduce((total, slot) => total + slot.probabilityPpm, 0)
  if (field === "edition" && sum !== 1_000_000) {
    return `The chances add up to ${sum.toLocaleString("en")}, not 1,000,000. (${error})`
  }
  return unusableWords(field, error)
}

function notRunWords(name: CheckName, report: VerificationReport, input: VerificationInput): string {
  if (name === "drawnItemId" && input.snapshot && input.expected.itemId === undefined) return NOT_TOLD_ITEM
  if (!input.snapshot && STEP_OF[name] === 4 && name !== "drawnSlotIndex") return NO_PRIZE_LIST
  if (input.serverSeedHex === null) return SEED_LOCKED
  return `not run: ${report.notRun.find((n) => n.check === name)?.reason ?? "no reason given"}`
}

function StepBytes({ step, report, input }: Props & { step: StepNumber }) {
  const { checks, trace } = report
  switch (step) {
    case 1:
      return (
        <div className="space-y-2">
          <p className="text-sm">
            {input.serverSeedHex === null ? (
              "The secret: not revealed yet."
            ) : (
              <>
                The secret we revealed: <code className="break-all font-mono text-xs">{input.serverSeedHex}</code>
              </>
            )}
          </p>
          {checks.commitment ? (
            <Compare
              label="commitment"
              expectedLabel="Fingerprint our server published"
              computedLabel="Fingerprint your browser computed"
              check={checks.commitment}
            />
          ) : null}
        </div>
      )
    case 2:
      return (
        <div className="space-y-2">
          <table className="w-full text-xs">
            <caption className="text-left text-sm text-muted-foreground">The chances of this box</caption>
            <thead>
              <tr className="text-left">
                <th scope="col">Slot</th>
                <th scope="col">Chance</th>
                <th scope="col">Buy-back value (cents)</th>
                <th scope="col">Market value (cents)</th>
              </tr>
            </thead>
            <tbody>
              {input.edition.slots.map((s) => (
                <tr key={s.slotIndex}>
                  <td>{s.slotIndex}</td>
                  <td>{percent(s.probabilityPpm)}</td>
                  <td>{String(s.requiredBuyBackValueCents)}</td>
                  <td>{String(s.requiredMarketValueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {checks.editionFingerprint ? (
            <Compare
              label="editionFingerprint"
              expectedLabel="Fingerprint recorded on your open"
              computedLabel="Fingerprint your browser computed"
              check={checks.editionFingerprint}
            />
          ) : null}
          {trace.editionPreimageHex ? (
            <ByteGroups caption="The exact bytes the fingerprint is computed from" groups={editionGroups(trace.editionPreimageHex)} />
          ) : null}
        </div>
      )
    case 3:
      if (trace.message === undefined || trace.chunks === undefined) return null
      return (
        <div className="space-y-2">
          <p className="text-sm">
            The message that was mixed: <code className="font-mono text-xs">{trace.message}</code> (client seed : counter : try)
          </p>
          <p className="text-sm">
            The 32 bytes:{" "}
            <code className="break-all font-mono text-xs">{(trace.hmacHex ?? "").match(/.{8}/g)?.join(" ")}</code>
          </p>
          <Chunks chunks={trace.chunks} value={trace.value} />
          {checks.drawnPpmValue ? (
            <Compare label="drawnPpmValue" expectedLabel="v we recorded" computedLabel="v your browser computed" check={checks.drawnPpmValue} />
          ) : null}
        </div>
      )
    case 4:
      return (
        <div className="space-y-2">
          {trace.cumulative ? (
            <table className="w-full text-xs">
              <caption className="text-left text-sm text-muted-foreground">
                The ranges{trace.value === undefined ? "" : `; v = ${trace.value.toLocaleString("en")}`}
              </caption>
              <thead>
                <tr className="text-left">
                  <th scope="col">Slot</th>
                  <th scope="col">Numbers it owns</th>
                  <th scope="col">Contains v</th>
                </tr>
              </thead>
              <tbody>
                {trace.cumulative.map((row) => {
                  // The library's own lookup decides the row; the page does not compare v with the bounds.
                  const has = row.slotIndex === trace.computedSlotIndex
                  return (
                    <tr key={row.slotIndex} data-contains-v={has ? "yes" : "no"} className={has ? "font-semibold" : ""}>
                      <td>{row.slotIndex}</td>
                      <td>
                        {row.to === row.from ? "none" : `${row.from.toLocaleString("en")} to ${(row.to - 1).toLocaleString("en")}`}
                      </td>
                      <td>{has ? "yes, here" : ""}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : null}
          {checks.drawnSlotIndex ? (
            <Compare label="drawnSlotIndex" expectedLabel="Slot we recorded" computedLabel="Slot your browser found" check={checks.drawnSlotIndex} />
          ) : null}
          {input.snapshot ? (
            <>
              {checks.snapshotHash ? (
                <Compare
                  label="snapshotHash"
                  expectedLabel="Prize list fingerprint recorded on your open"
                  computedLabel="Prize list fingerprint your browser computed"
                  check={checks.snapshotHash}
                />
              ) : null}
              {checks.snapshotEditionLink ? <LinkView check={checks.snapshotEditionLink} boxFingerprint={trace.computedEditionFingerprint} /> : null}
              {checks.drawnItemId ? (
                <Compare label="drawnItemId" expectedLabel="Item recorded for your win" computedLabel="Item in that slot" check={checks.drawnItemId} />
              ) : trace.itemIdInDrawnSlot !== undefined ? (
                <p className="text-sm" data-compare="drawnItemId">
                  Item in that slot: <code className="font-mono text-xs">{trace.itemIdInDrawnSlot}</code>. The item you
                  received was {NOT_TOLD_ITEM}.
                </p>
              ) : null}
              {trace.snapshotPreimageHex ? (
                <ByteGroups caption="The exact bytes of the prize list" groups={snapshotGroups(trace.snapshotPreimageHex)} />
              ) : null}
            </>
          ) : null}
        </div>
      )
  }
}

/**
 * The link between the prize list and the box. The library compares the box fingerprint first, and
 * then the two slot lists; its check holds whichever pair it compared, and the labels follow that.
 */
function LinkView({ check, boxFingerprint }: { check: Check; boxFingerprint: string | undefined }) {
  const fingerprints = check.expected === boxFingerprint
  return (
    <Compare
      label="snapshotEditionLink"
      expectedLabel={fingerprints ? "Box fingerprint your browser computed in step 2" : "Slots of this box"}
      computedLabel={fingerprints ? "Box fingerprint written inside the prize list" : "Slots in the prize list"}
      check={check}
    />
  )
}

function percent(ppm: number): string {
  return `${(ppm / 10_000).toLocaleString("en", { maximumFractionDigits: 4 })}%`
}
