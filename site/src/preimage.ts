/** One named field of a preimage: its bytes as hex, and what they mean. */
export interface ByteGroup {
  name: string
  hex: string
  meaning: string
}

/** A reader over a preimage's hex, one named field at a time. */
class Cursor {
  private at = 0
  readonly groups: ByteGroup[] = []
  constructor(private readonly hex: string) {}

  take(name: string, bytes: number, meaning: (hex: string) => string): string {
    const hex = this.hex.slice(this.at, this.at + bytes * 2)
    this.at += bytes * 2
    this.groups.push({ name, hex, meaning: meaning(hex) })
    return hex
  }

  get done(): boolean {
    return this.at >= this.hex.length
  }
}

const u32 = (hex: string) => String(Number.parseInt(hex, 16))
const i64 = (hex: string) => String(BigInt.asIntN(64, BigInt(`0x${hex}`)))
const uuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

/** The `0x01` edition preimage, cut into its named fields. */
export function editionGroups(preimageHex: string): ByteGroup[] {
  const c = new Cursor(preimageHex)
  c.take("version", 1, (h) => `format ${u32(h)}`)
  c.take("engine id", 16, uuid)
  c.take("engine version", 4, u32)
  c.take("price (cents)", 8, i64)
  const count = Number(u32(c.take("slot count", 4, u32)))
  for (let s = 0; s < count && !c.done; s++) {
    const index = u32(c.take(`slot index`, 4, u32))
    c.take(`slot ${index}: chance (ppm)`, 4, u32)
    c.take(`slot ${index}: buy-back value (cents)`, 8, i64)
    c.take(`slot ${index}: market value (cents)`, 8, i64)
  }
  return c.groups
}

/** The `0x03` prize-list preimage, cut into its named fields. */
export function snapshotGroups(preimageHex: string): ByteGroup[] {
  const c = new Cursor(preimageHex)
  c.take("version", 1, (h) => `format ${u32(h)}`)
  c.take("box fingerprint", 32, () => "the fingerprint of step 2")
  const count = Number(u32(c.take("slot count", 4, u32)))
  for (let s = 0; s < count && !c.done; s++) {
    const index = u32(c.take("slot index", 4, u32))
    c.take(`slot ${index}: item`, 16, uuid)
    c.take(`slot ${index}: displayed value (cents)`, 8, i64)
    const length = Number(u32(c.take(`slot ${index}: label length`, 4, (h) => `${u32(h)} bytes`)))
    c.take(`slot ${index}: label`, length, (h) => new TextDecoder().decode(hexBytes(h)))
  }
  return c.groups
}

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)))
}
