import { UPGRADE_STEP_CHECK_NAMES, upgradeRule, type UpgradeStepInput, type UpgradeStepReport } from "@verifier"
import { ByteGroups, Chunks, Compare } from "./bytes"
import { editionGroups } from "./preimage"
import { amountCentsOf } from "./proof"
import { SourceLine } from "./steps"
import {
  DEPENDENT_NOTE,
  DEPENDS_ON,
  DEMO_STEP_NOTE,
  SEED_LOCKED,
  STEP1_PENDING,
  UPGRADE_STEP_OF,
  UPGRADE_STEPS,
  UPGRADE_TARGET_ROW,
  UPGRADE_V4_WORDS,
  amountText,
  type StepNumber,
  type UpgradeStepName,
  percentDown,
  stepFailWords,
  upgradeCheckWords,
  upgradeStep2,
  unusableWords,
} from "./words"

interface Props {
  report: UpgradeStepReport
  input: UpgradeStepInput
}

/**
 * The four cards of an upgrade step (KAN-1154). Like the open's cards, every step is drawn, run or not,
 * and every value shown is the library's: the page compares nothing itself.
 */
export function UpgradeStepCards({ report, input }: Props) {
  const names: readonly UpgradeStepName[] = UPGRADE_STEP_CHECK_NAMES
  const failedSteps = new Set(names.filter((n) => report.checks[n]?.ok === false).map((n) => UPGRADE_STEP_OF[n]))
  const pending = input.serverSeedHex === null
  const dependsOnFailed = (step: StepNumber): boolean => DEPENDS_ON[step].some((d) => failedSteps.has(d) || dependsOnFailed(d))
  // Each version's words where they differ (version 2: KAN-1567; version 3, with the box's rate: KAN-1751;
  // version 4, with the amount the step records: KAN-1569).
  const amount = amountOf(input)
  const words = upgradeCheckWords(input.edition.engineVersion, report.trace.stepRateBps, amount)
  const step2 = upgradeStep2(input.edition.engineVersion, report.trace.stepRateBps, amount)

  return (
    <div className="space-y-6">
      {UPGRADE_STEPS.map(({ step, title: stepTitle, method, text: stepText, source }) => {
        const failed = failedSteps.has(step)
        const title = pending && step === 1 ? STEP1_PENDING.title : step === 2 ? step2.title : stepTitle
        const text = pending && step === 1 ? STEP1_PENDING.text : step === 2 ? step2.text : stepText
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
              {failed ? <span className="ml-2 text-fail">(does not match)</span> : null}
            </h2>
            <SourceLine source={source} />
            {text.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {step === 2 && report.trace.ruleSet === "DEMO_RULES_2026_11_17" ? (
              <p className="font-semibold" data-demo="yes">
                {DEMO_STEP_NOTE}
              </p>
            ) : null}
            {dependsOnFailed(step) ? (
              <p className="font-semibold" data-dependent="yes">
                {DEPENDENT_NOTE}
              </p>
            ) : null}
            <ul className="space-y-2" aria-label={`The checks of step ${step}`}>
              {names
                .filter((name) => UPGRADE_STEP_OF[name] === step)
                .map((name) => {
                  const check = report.checks[name]
                  const state = check
                    ? check.ok
                      ? "matches"
                      : check.error !== undefined
                        ? "cannot be checked"
                        : "does not match"
                    : pending
                      ? SEED_LOCKED
                      : `not run: ${report.notRun.find((n) => n.check === name)?.reason ?? "no reason given"}`
                  const sentence = !check
                    ? null
                    : check.ok
                      ? words.ok[name]
                      : check.error !== undefined
                        ? unusableWords(check.field, check.error)
                        : stepFailWords(name, check, words)
                  return (
                    <li key={name} data-check={name} data-state={check ? (check.ok ? "match" : "mismatch") : "not-run"}>
                      <span className="font-medium">{words.labels[name]}:</span>{" "}
                      <span className="font-semibold">{state}</span>
                      {sentence ? `. ${sentence}` : null}
                    </li>
                  )
                })}
            </ul>
            <StepValues step={step} report={report} input={input} />
            {method ? <p className="text-xs text-muted-foreground">Method: {method}</p> : null}
          </section>
        )
      })}
    </div>
  )
}

/** The amount the step records, in cents; a wrongly formed one never reaches a sentence. */
function amountOf(input: UpgradeStepInput): number | undefined {
  return amountCentsOf(input.expected.boostCents, "expected.boostCents")
}

function StepValues({ step, report, input }: Props & { step: StepNumber }) {
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
    case 2: {
      const staked = input.edition.slots.find((s) => s.slotIndex === input.expected.stakedSlotIndex)
      const offered = trace.computedOffer
      const target = offered ? input.edition.slots.find((s) => s.slotIndex === offered.targetSlotIndex) : undefined
      // With an amount, the offer's chance is the one with no amount, and the chance the library checked is
      // the one with the amount (absent when the amount reaches the target's value): both are its numbers.
      const amount = amountOf(input)
      const withAmount = checks.upgradeChance?.error === undefined && checks.upgradeChance?.computed !== undefined ? Number(checks.upgradeChance.computed) : undefined
      const fair = amount === undefined ? offered?.chancePpm : withAmount
      return (
        <div className="space-y-2">
          <table className="w-full text-xs" data-upgrade-values>
            <caption className="text-left text-sm text-muted-foreground">The upgrade, as your browser computed it</caption>
            <tbody>
              <tr>
                <th scope="row" className="text-left font-medium">You gave up</th>
                <td>
                  slot {input.expected.stakedSlotIndex}
                  {staked ? `, buy-back value ${String(staked.requiredBuyBackValueCents)} cents` : ""}
                </td>
              </tr>
              <tr>
                <th scope="row" className="text-left font-medium">
                  {upgradeRule(input.edition.engineVersion)?.jumps === false ? UPGRADE_TARGET_ROW.nextUp : UPGRADE_TARGET_ROW.target}
                </th>
                <td>
                  {offered && target
                    ? `slot ${offered.targetSlotIndex}, buy-back value ${String(target.requiredBuyBackValueCents)} cents`
                    : "none"}
                </td>
              </tr>
              {amount !== undefined ? (
                <tr data-amount-row>
                  <th scope="row" className="text-left font-medium">{UPGRADE_V4_WORDS.rows.amount}</th>
                  <td>{`${String(amount)} cents (${amountText(amount)})`}</td>
                </tr>
              ) : null}
              {amount !== undefined ? (
                <tr data-no-amount-row>
                  <th scope="row" className="text-left font-medium">{UPGRADE_V4_WORDS.rows.noAmountChance}</th>
                  <td>{offered ? `${offered.chancePpm.toLocaleString("en")} in 1,000,000 (${percentDown(offered.chancePpm)})` : "none"}</td>
                </tr>
              ) : null}
              <tr>
                <th scope="row" className="text-left font-medium">Fair chance</th>
                <td>{fair !== undefined ? `${fair.toLocaleString("en")} in 1,000,000 (${percentDown(fair)})` : "none"}</td>
              </tr>
            </tbody>
          </table>
          {checks.upgradeChance ? (
            <Compare label="upgradeChance" expectedLabel="Chance we recorded" computedLabel="Chance your browser computed" check={checks.upgradeChance} />
          ) : null}
          {checks.editionFingerprint ? (
            <Compare
              label="editionFingerprint"
              expectedLabel="Fingerprint recorded on your upgrade"
              computedLabel="Fingerprint your browser computed"
              check={checks.editionFingerprint}
            />
          ) : null}
          {trace.editionPreimageHex ? (
            <ByteGroups caption="The exact bytes the fingerprint is computed from" groups={editionGroups(trace.editionPreimageHex)} />
          ) : null}
        </div>
      )
    }
    case 3:
      if (trace.message === undefined || trace.chunks === undefined) return null
      return (
        <div className="space-y-2">
          <p className="text-sm">
            The message that was mixed: <code className="font-mono text-xs">{trace.message}</code> (client seed : counter : try)
          </p>
          <p className="text-sm">
            The 32 bytes: <code className="break-all font-mono text-xs">{(trace.hmacHex ?? "").match(/.{8}/g)?.join(" ")}</code>
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
          {trace.cumulative ? <TwoRanges ranges={trace.cumulative} value={trace.value} outcome={trace.computedOutcome} /> : null}
          {checks.upgradeOutcome ? (
            <Compare label="upgradeOutcome" expectedLabel="Result we recorded" computedLabel="Result your browser found" check={checks.upgradeOutcome} />
          ) : null}
        </div>
      )
  }
}

/**
 * The two ranges of an upgrade, on its own page and under an upgraded win: row 0 wins, row 1 loses, and
 * the row is marked by the library's own reading of v, never by a slot index.
 */
export function TwoRanges({ ranges, value, outcome }: { ranges: readonly { slotIndex: number; from: number; to: number }[]; value: number | undefined; outcome: "won" | "lost" | undefined }) {
  return (
    <table className="w-full text-xs">
      <caption className="text-left text-sm text-muted-foreground">
        The two ranges{value === undefined ? "" : `; v = ${value.toLocaleString("en")}`}
      </caption>
      <thead>
        <tr className="text-left">
          <th scope="col">Result</th>
          <th scope="col">Numbers it owns</th>
          <th scope="col">Contains v</th>
        </tr>
      </thead>
      <tbody>
        {ranges.map((row) => {
          // The library's own reading decides the row; the page does not compare v with the bounds.
          const word = row.slotIndex === 0 ? "won" : "lost"
          const has = outcome === word
          return (
            <tr key={row.slotIndex} data-contains-v={has ? "yes" : "no"} className={has ? "font-semibold" : ""}>
              <td>{word}</td>
              <td>{`${row.from.toLocaleString("en")} to ${(row.to - 1).toLocaleString("en")}`}</td>
              <td>{has ? "yes, here" : ""}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
