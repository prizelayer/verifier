/**
 * The proof with line breaks and indents added, for reading only. It works on the characters and
 * only ever adds whitespace outside strings: nothing is parsed, so no number can be rounded, and
 * the box, the check and the saved file keep the exact text. A text that already has whitespace
 * outside its strings was laid out by whoever wrote it and comes back as it is, and so does a text
 * whose brackets close more than they open.
 */
export function layOut(text: string): string {
  const parts = layOutParts(text)
  return parts === null ? text : parts.map((part) => part.text).join("")
}

/** The laid-out text as pieces, each marked as the proof's own text or as added whitespace. */
export function layOutParts(text: string): { text: string; added: boolean }[] | null {
  const parts: { text: string; added: boolean }[] = []
  const own = (piece: string) => parts.push({ text: piece, added: false })
  const add = (depth: number) => parts.push({ text: "\n" + "  ".repeat(depth), added: true })
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      own(c)
      if (c === "\\") own(text[++i] ?? "")
      else if (c === '"') inString = false
      continue
    }
    if (/\s/.test(c)) return null
    if (c === '"') inString = true
    // A closing bracket with nothing open is not JSON: the text comes back as it is, never a thrown
    // RangeError from a negative indent, which would blank the page.
    if ((c === "}" || c === "]") && depth === 0) return null
    if ((c === "}" || c === "]") && !(text[i - 1] === "{" || text[i - 1] === "[")) add(--depth)
    else if (c === "}" || c === "]") depth--
    own(c)
    if ((c === "{" || c === "[") && !(text[i + 1] === "}" || text[i + 1] === "]")) add(++depth)
    else if (c === "{" || c === "[") depth++
    else if (c === ",") add(depth)
    else if (c === ":") parts.push({ text: " ", added: true })
  }
  return parts
}
