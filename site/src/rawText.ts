/**
 * The exact text of the object at `path` inside the JSON `text`, or `null` if it is not there.
 *
 * Why the text and not the parsed value: the snapshot body publishes `displayed_value_cents` as bare
 * JSON numbers, and `JSON.parse` rounds any of them above 2^53 before the library can see it. The
 * library re-reads those literals exactly when it is given the body as TEXT, so the page hands it
 * the body's own characters, cut out of the pasted proof. Each key is looked up among the direct
 * members of the object before it only, so a same-named key nested elsewhere is never taken.
 */
export function rawObjectText(text: string, path: readonly string[]): string | null {
  let open = skipSpace(text, 0)
  for (const key of path) {
    if (text[open] !== "{") return null
    const value = memberValue(text, open, key)
    if (value < 0) return null
    open = value
  }
  if (text[open] !== "{") return null
  const end = endOfValue(text, open)
  return end < 0 ? null : text.slice(open, end)
}

/** Where the value of the direct member `key` of the object opening at `open` starts, or -1. */
function memberValue(text: string, open: number, key: string): number {
  let i = skipSpace(text, open + 1)
  while (i < text.length && text[i] !== "}") {
    const keyEnd = endOfValue(text, i)
    if (keyEnd < 0 || text[i] !== '"') return -1
    const name = JSON.parse(text.slice(i, keyEnd)) as string
    const colon = skipSpace(text, keyEnd)
    if (text[colon] !== ":") return -1
    const value = skipSpace(text, colon + 1)
    if (name === key) return value
    const valueEnd = endOfValue(text, value)
    if (valueEnd < 0) return -1
    i = skipSpace(text, valueEnd)
    if (text[i] === ",") i = skipSpace(text, i + 1)
  }
  return -1
}

/** The index just after the JSON value starting at `at`, or -1 if it does not end. */
function endOfValue(text: string, at: number): number {
  if (text[at] === '"') {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") i++
      else if (text[i] === '"') return i + 1
    }
    return -1
  }
  if (text[at] === "{" || text[at] === "[") {
    let depth = 0
    for (let i = at; i < text.length; i++) {
      const c = text[i]
      if (c === '"') {
        const end = endOfValue(text, i)
        if (end < 0) return -1
        i = end - 1
      } else if (c === "{" || c === "[") depth++
      else if ((c === "}" || c === "]") && --depth === 0) return i + 1
    }
    return -1
  }
  let i = at
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i++
  return i > at ? i : -1
}

function skipSpace(text: string, at: number): number {
  let i = at
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/**
 * The first object key that appears twice in the same object, anywhere in the JSON `text`, or `null`.
 *
 * Two members with one name are read differently by different tools: `JSON.parse` keeps the last,
 * and a cutter like {@link rawObjectText} could keep the first. A proof that two honest tools would
 * read differently is refused rather than resolved, so nobody has to guess which one was checked.
 */
export function duplicateKey(text: string): string | null {
  const found = { name: null as string | null }
  walk(text, skipSpace(text, 0), found)
  return found.name
}

/** Walks one value, recording the first duplicate key; returns the index after the value, or -1. */
function walk(text: string, at: number, found: { name: string | null }): number {
  if (found.name !== null) return -1
  if (text[at] === "{") {
    const names = new Set<string>()
    let i = skipSpace(text, at + 1)
    while (i < text.length && text[i] !== "}") {
      const keyEnd = endOfValue(text, i)
      if (keyEnd < 0 || text[i] !== '"') return -1
      const name = JSON.parse(text.slice(i, keyEnd)) as string
      if (names.has(name)) {
        found.name = name
        return -1
      }
      names.add(name)
      const colon = skipSpace(text, keyEnd)
      if (text[colon] !== ":") return -1
      const end = walk(text, skipSpace(text, colon + 1), found)
      if (end < 0) return -1
      i = skipSpace(text, end)
      if (text[i] === ",") i = skipSpace(text, i + 1)
    }
    return i + 1
  }
  if (text[at] === "[") {
    let i = skipSpace(text, at + 1)
    while (i < text.length && text[i] !== "]") {
      const end = walk(text, i, found)
      if (end < 0) return -1
      i = skipSpace(text, end)
      if (text[i] === ",") i = skipSpace(text, i + 1)
    }
    return i + 1
  }
  return endOfValue(text, at)
}
