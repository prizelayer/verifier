import type { BuildInfo } from "../scripts/build-info"
import { BUILD } from "./build"
import { FOOTER } from "./words"

export const REPO_URL = "https://github.com/prizelayer/verifier"
declare const __VERIFIER_SUMS_URL__: string

/**
 * The list of the latest publish, as the GitHub Pages host serves it: a host we do not run. Each
 * environment's copy links its own list (environments.json, fixed at build time).
 */
export const SUMS_URL: string = __VERIFIER_SUMS_URL__

const link = "underline underline-offset-2"

export function Footer({ build = BUILD }: { build?: BuildInfo | null }) {
  return (
    <footer aria-labelledby="where-from" className="mx-auto max-w-3xl px-4 pb-10 space-y-2 text-sm text-muted-foreground">
      <h2 id="where-from" className="font-semibold">
        {FOOTER.title}
      </h2>
      {build === null ? (
        <p>
          {FOOTER.notPublished}{" "}
          <a className={link} href={REPO_URL} rel="noreferrer">
            prizelayer/verifier
          </a>
          .
        </p>
      ) : (
        <>
          <p>
            {FOOTER.built}{" "}
            <a className={link} href={`${REPO_URL}/commit/${build.commit}`} rel="noreferrer">
              <code>{build.commit.slice(0, 12)}</code>
            </a>{" "}
            {FOOTER.ofRepo}{" "}
            <a className={link} href={REPO_URL} rel="noreferrer">
              prizelayer/verifier
            </a>
            , {FOOTER.byRun} {build.runId} {FOOTER.ofWorkflow}
          </p>
          <p>{FOOTER.sums}</p>
          <p>
            <a className={link} href={SUMS_URL} rel="noreferrer">
              {FOOTER.sumsLink}
            </a>
            {" · "}
            <a className={link} href={`${REPO_URL}/actions/runs/${build.runId}`} rel="noreferrer">
              {FOOTER.runLink}
            </a>
          </p>
          <p>{FOOTER.noSelfHash}</p>
        </>
      )}
    </footer>
  )
}
