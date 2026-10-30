import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { API_BASE, fromFragment, lookUp, normalId, type LookupResult } from "./lookup"
import { layOut } from "./layOut"
import { LOOKUP_WORDS } from "./words"

/**
 * Look an open up by its id. Nothing is fetched until the reader presses "Look up", also when the
 * id came in the page's address (`#open=<winId>&item=<itemId>`, a fragment no server ever sees).
 */
export function LookupBox({
  disabled,
  shownText,
  onFound,
  onBusy,
  fetchFn,
}: {
  disabled: boolean
  /** The proof in the box now: "Save this proof" is offered only while it is the fetched one. */
  shownText: string
  onFound: (text: string) => void
  /** Told when a lookup starts and ends, so the page can lock the box meanwhile. */
  onBusy?: (busy: boolean) => void
  fetchFn?: typeof fetch
}) {
  const fieldId = useId()
  // The address is read once, when the page opens; nothing is fetched from it.
  const [fromAddress] = useState(() => fromFragment(window.location.hash))
  const [winId, setWinId] = useState(fromAddress?.winId ?? "")
  // The item id in the address belongs to the open in the address, not to an id typed later.
  const itemId = fromAddress !== null && normalId(winId) === normalId(fromAddress.winId) ? fromAddress.itemId : null
  const [busy, setBusy] = useState(false)
  // The guard a second press checks. The state above is for the screen, and two presses in one task
  // (a script clicking "Look up" twice) both read it before React draws again; this ref they do not.
  const pressing = useRef(false)
  // The result, with the id it was looked up for: the saved file is named after that id.
  const [result, setResult] = useState<{ asked: string; result: LookupResult } | null>(null)
  // What is on screen now, read when an answer arrives: an answer is kept only for the id and the
  // box it was asked from, so a late answer never lands on another id or over another proof.
  const current = useRef({ winId, shownText })
  useEffect(() => {
    current.current = { winId, shownText }
  })

  async function press() {
    // While busy the button keeps its focus (aria-disabled, not disabled), so a press is ignored here.
    if (pressing.current || disabled) return
    // The id is fetched, shown and named in the saved file in lower case.
    const asked = normalId(winId)
    if (asked === "") return
    if (asked !== winId) setWinId(asked)
    const boxAtPress = shownText
    let found: LookupResult
    try {
      // Taken inside the try: if anything below throws, finally still frees the button.
      pressing.current = true
      setBusy(true)
      onBusy?.(true)
      setResult(null)
      found = await lookUp(asked, itemId, fetchFn)
    } catch (error) {
      // lookUp returns every fault of the network and of our server as a result, so what reaches here
      // is the page's own: it is named so, and kept in the console for whoever reports it.
      console.error("lookup failed in the page", error)
      found = { kind: "pageFault" }
    } finally {
      pressing.current = false
      setBusy(false)
      onBusy?.(false)
    }
    if (normalId(current.current.winId) !== asked || current.current.shownText !== boxAtPress) return
    setResult({ asked, result: found })
    if (found.kind === "found") onFound(found.text)
  }

  const fetched = result?.result.kind === "found" ? result.result.text : null
  // Laid out once per proof, not on every render: the text can be megabytes.
  const laidOut = useMemo(() => (fetched === null ? "" : layOut(fetched)), [fetched])
  const resultId = `${fieldId}-result`
  const invalid = result?.result.kind === "notAnId" || result?.result.kind === "notFound"
  return (
    <section aria-labelledby={`${fieldId}-label`} aria-busy={busy} className="space-y-3">
      <label id={`${fieldId}-label`} htmlFor={fieldId} className="block font-medium">
        Look up an open by its id
      </label>
      <p id={`${fieldId}-help`} className="text-sm text-muted-foreground">
        {LOOKUP_WORDS.help}
      </p>
      <p className="text-sm text-muted-foreground">
        This is the only time the page contacts our server: when you press "Look up", it fetches the public data of
        that open from {new URL(API_BASE).host}. The check itself still runs in your browser.
      </p>
      {/* No form: a submit does nothing in a frame sandboxed without allow-forms, as in the player's
          overlay. The search landmark the form gave is kept, named by the label above. */}
      <div role="search" aria-labelledby={`${fieldId}-label`} className="flex flex-col gap-2 sm:flex-row">
        {/* A wrapping field: an id is 36 characters and must be readable in full on a phone. */}
        <textarea
          id={fieldId}
          value={winId}
          onChange={(event) => {
            setWinId(event.target.value.replace(/[\r\n]/g, ""))
            setResult(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter in the field presses "Look up"; nothing is ever submitted to a server.
              event.preventDefault()
              void press()
            }
          }}
          readOnly={busy}
          rows={2}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          placeholder={LOOKUP_WORDS.placeholder}
          aria-describedby={result !== null || busy ? `${fieldId}-help ${resultId}` : `${fieldId}-help`}
          className="min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-base break-all sm:h-9 sm:py-1.5 sm:text-sm"
        />
        <Button
          type="button"
          onClick={() => void press()}
          className="self-start aria-disabled:opacity-50"
          disabled={disabled || winId.trim() === ""}
          aria-disabled={busy || undefined}
        >
          Look up
        </Button>
      </div>
      <div id={resultId} aria-live="polite" data-lookup={busy ? "busy" : (result?.result.kind ?? "idle")}>
        {busy ? (
          <p className="border-l-2 border-muted-foreground pl-3">{LOOKUP_WORDS.busy}</p>
        ) : result ? (
          <LookupWords result={result.result} />
        ) : null}
      </div>
      {result !== null && fetched !== null && fetched === shownText ? (
        <div className="space-y-2">
          <Button variant="outline" onClick={() => save(fetched, result.asked)}>
            Save this proof
          </Button>
          <p className="text-sm text-muted-foreground">{LOOKUP_WORDS.sharing}</p>
          {/* For reading only: the field, the check and the saved file keep the exact text. */}
          <details className="text-sm">
            <summary className="cursor-pointer">Show this proof laid out</summary>
            {/* Wrapped, so a phone shows every value; a soft wrap adds no character to the text. */}
            <pre
              data-laid-out
              className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border p-3 font-mono text-xs"
            >
              {laidOut}
            </pre>
          </details>
        </div>
      ) : null}
    </section>
  )
}

const FAULT = "border-l-2 border-fail pl-3 text-fail"

function LookupWords({ result }: { result: LookupResult }) {
  switch (result.kind) {
    case "found":
      return <p>{LOOKUP_WORDS.found}</p>
    case "notAnId":
      return <p className={FAULT}>{LOOKUP_WORDS.notAnId}</p>
    case "notFound":
      return <p className={FAULT}>{LOOKUP_WORDS.notFound}</p>
    case "unreachable":
      return <p className={FAULT}>{LOOKUP_WORDS.unreachable}</p>
    case "timedOut":
      return <p className={FAULT}>{LOOKUP_WORDS.timedOut}</p>
    case "serverFault":
      return <p className={FAULT}>{LOOKUP_WORDS.serverFault(result.message)}</p>
    case "pageFault":
      return <p className={FAULT}>{LOOKUP_WORDS.pageFault}</p>
  }
}

/** Downloads the proof as a file; nothing is stored in the browser. */
function save(text: string, winId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `proof-${winId}.json`
  link.click()
  // Released on the next turn: some browsers cancel a download whose URL is released at once.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
