import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { API_BASE, fromFragment, lookUp, type LookupResult } from "./lookup"
import { LOOKUP_WORDS } from "./words"

/**
 * Look an open up by its id. Nothing is fetched until the reader presses "Look up", also when the
 * id came in the page's address (`#open=<winId>&item=<itemId>`, a fragment no server ever sees).
 */
export function LookupBox({
  disabled,
  shownText,
  onFound,
  fetchFn,
}: {
  disabled: boolean
  /** The proof in the box now: "Save this proof" is offered only while it is the fetched one. */
  shownText: string
  onFound: (text: string) => void
  fetchFn?: typeof fetch
}) {
  const fieldId = useId()
  // The address is read once, when the page opens; nothing is fetched from it.
  const [fromAddress] = useState(() => fromFragment(window.location.hash))
  const [winId, setWinId] = useState(fromAddress?.winId ?? "")
  // The item id in the address belongs to the open in the address, not to an id typed later.
  const itemId = fromAddress !== null && winId.trim() === fromAddress.winId ? fromAddress.itemId : null
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LookupResult | null>(null)

  async function press() {
    setBusy(true)
    setResult(null)
    let found: LookupResult
    try {
      found = await lookUp(winId, itemId, fetchFn)
    } catch {
      found = { kind: "serverFault", message: "its answer could not be read" }
    } finally {
      setBusy(false)
    }
    setResult(found)
    if (found.kind === "found") onFound(found.text)
  }

  const fetched = result?.kind === "found" ? result.text : null
  return (
    <section aria-labelledby={`${fieldId}-label`} className="space-y-3">
      <label id={`${fieldId}-label`} htmlFor={fieldId} className="block font-medium">
        Look up an open by its id
      </label>
      <p className="text-sm text-muted-foreground">
        This is the only time the page contacts our server: when you press "Look up", it fetches the public data of
        that open from {new URL(API_BASE).host}. The check itself still runs in your browser.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id={fieldId}
          value={winId}
          onChange={(event) => {
            setWinId(event.target.value)
            setResult(null)
          }}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
        />
        <Button onClick={() => void press()} disabled={disabled || busy || winId.trim() === ""}>
          Look up
        </Button>
      </div>
      <div aria-live="polite" data-lookup={busy ? "busy" : (result?.kind ?? "idle")}>
        {busy ? <p>{LOOKUP_WORDS.busy}</p> : result ? <LookupWords result={result} /> : null}
      </div>
      {fetched !== null && fetched === shownText ? (
        <div className="space-y-1">
          <Button variant="outline" onClick={() => save(fetched, winId.trim())}>
            Save this proof
          </Button>
          <p className="text-sm">{LOOKUP_WORDS.sharing}</p>
        </div>
      ) : null}
    </section>
  )
}

function LookupWords({ result }: { result: LookupResult }) {
  switch (result.kind) {
    case "found":
      return <p>{LOOKUP_WORDS.found}</p>
    case "notAnId":
      return <p className="text-fail">{LOOKUP_WORDS.notAnId}</p>
    case "notFound":
      return <p className="text-fail">{LOOKUP_WORDS.notFound}</p>
    case "unreachable":
      return <p className="text-fail">{LOOKUP_WORDS.unreachable}</p>
    case "serverFault":
      return <p className="text-fail">{LOOKUP_WORDS.serverFault(result.message)}</p>
  }
}

/** Downloads the proof as a file; nothing is stored in the browser. */
function save(text: string, winId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `proof-${winId}.json`
  link.click()
  URL.revokeObjectURL(url)
}
