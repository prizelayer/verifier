import { CHECK_NAMES, STEP_OF, type Check, type CheckName, type VerificationInput, type VerificationReport } from "@verifier"
import { ByteGroups, Chunks, Compare } from "./bytes"
import { editionGroups, snapshotGroups } from "./preimage"
import { amountCentsOf } from "./proof"
import { Rows } from "./rows"
import { TwoRanges } from "./upgradeSteps"
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
  UPGRADE_JUMP_WORDS,
  UPGRADE_V4_WORDS,
  amountRefusal,
  upgradeWinStep4,
  upgradeWords,
  stepJumps,
  unusableWords,
  wrongChanceLabels,
  wrongChanceShown,
  wrongChanceWords,
} from "./words"

interface Props {
  report: VerificationReport
  input: VerificationInput
}

/**
 * The four step cards. Every step is drawn, run or not, so a missing value is named, never hidden.
 * `seedSet`: what our record says about who set this pair's client seed, added to step 3 after the
 * paragraph about who makes the client seed; none by default. No other step gets a sentence.
 */
export function StepCards({ report, input, seedSet = null }: Props & { seedSet?: string | null }) {
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
      {STEPS.map((card) => {
        // An upgraded win's number is read over the step's two ranges, so its card 4 is the step's.
        const { step, method } = card
        const { title: stepTitle, text: stepText, source } = input.gameKind === "upgrade" && step === 4 ? upgradeWinStep4(input.edition.engineVersion) : card
        const failed = failedSteps.has(step)
        // While the secret is locked, step 1 speaks of no revealed secret and of no comparison made.
        const title = pending && step === 1 ? STEP1_PENDING.title : stepTitle
        const text = pending && step === 1 ? STEP1_PENDING.text : stepText
        const said = step === 3 ? seedSet : null
        const paragraphs = said === null ? text : [...text.slice(0, 2), said, ...text.slice(2)]
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
            <SourceLine source={source} />
            {paragraphs.map((p) => (
              <p key={p} data-pair-record={p === said ? "yes" : undefined}>
                {p}
              </p>
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
              : name === "drawnSlotIndex"
                ? winFailWords(check, input)
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

/**
 * Why an upgraded win's slot check failed: a refused amount in its own words (O3), a wrong chance in the
 * chance's words, otherwise the slot's. On version 4, a win whose open record carries no amount adds that
 * the upgrade may have had one (O4), because the upgrade's own page is where its amount is checked.
 */
function winFailWords(check: Check, input: VerificationInput): string {
  const refusal = amountRefusal(check)
  if (refusal) return UPGRADE_V4_WORDS.amountFail(refusal, "win")
  const chance = wrongChanceShown(check)
  const words = chance ? wrongChanceWords(chance, input.edition.engineVersion) : FAIL_WORDS.drawnSlotIndex
  const amountMissing =
    input.gameKind === "upgrade" && upgradeWords(input.edition.engineVersion).recordsAmount && input.expected.stepBoostCents === undefined
  return amountMissing ? `${words} ${UPGRADE_V4_WORDS.winAmountMissing}` : words
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
              <Rows
                rows={input.edition.slots}
                columns={4}
                keep={(s) => s.slotIndex === trace.computedSlotIndex}
                row={(s) => (
                  <tr key={s.slotIndex}>
                    <td>{s.slotIndex}</td>
                    <td>{percent(s.probabilityPpm)}</td>
                    <td>{String(s.requiredBuyBackValueCents)}</td>
                    <td>{String(s.requiredMarketValueCents)}</td>
                  </tr>
                )}
              />
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
    case 4: {
      // On a version where an upgrade names its target, the browser checks the slot the win records.
      const slotLabel =
        input.gameKind === "upgrade" && stepJumps(input.edition.engineVersion) ? UPGRADE_JUMP_WORDS.winSlotLabel : "Slot your browser found"
      const winAmount = amountCentsOf(input.expected.stepBoostCents, "expected.stepBoostCents")
      return (
        <div className="space-y-2">
          {input.gameKind === "upgrade" ? (
            // The step's two ranges, marked by the library's step outcome; while locked the library leaves none.
            trace.cumulative ? <TwoRanges ranges={trace.cumulative} value={trace.value} outcome={trace.computedStepOutcome} /> : null
          ) : trace.cumulative ? (
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
                <Rows
                  rows={trace.cumulative}
                  columns={3}
                  keep={(row) => row.slotIndex === trace.computedSlotIndex}
                  row={(row) => {
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
                  }}
                />
              </tbody>
            </table>
          ) : null}
          {checks.drawnSlotIndex ? (
            amountRefusal(checks.drawnSlotIndex) ? (
              <Compare label="drawnSlotIndex" expectedLabel="Amount recorded with this win" computedLabel="What your browser found" check={checks.drawnSlotIndex} />
            ) : wrongChanceShown(checks.drawnSlotIndex)?.kind === "recorded" ? (
              <Compare label="drawnSlotIndex" expectedLabel="Chance we recorded" computedLabel={wrongChanceLabels(input.edition.engineVersion).recorded} check={checks.drawnSlotIndex} />
            ) : wrongChanceShown(checks.drawnSlotIndex) ? (
              <Compare label="drawnSlotIndex" expectedLabel="Chance shown to you" computedLabel={wrongChanceLabels(input.edition.engineVersion).shown} check={checks.drawnSlotIndex} />
            ) : (
              <Compare label="drawnSlotIndex" expectedLabel="Slot we recorded" computedLabel={slotLabel} check={checks.drawnSlotIndex} />
            )
          ) : null}
          {input.gameKind === "upgrade" && checks.drawnSlotIndex?.ok && winAmount !== undefined && upgradeWords(input.edition.engineVersion).recordsAmount ? (
            <p className="text-sm" data-amount-chance>
              {UPGRADE_V4_WORDS.winChance(winAmount, input.expected.stepChancePpm as number)}
            </p>
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

/**
 * Where a step's values come from, under its title: the field names are
 * the proof's own, written between backticks in `words.ts` and shown as code, so a reader finds them
 * in the pasted proof.
 */
export function SourceLine({ source }: { source: string }) {
  return (
    <p data-source className="text-sm">
      {source.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
    </p>
  )
}
