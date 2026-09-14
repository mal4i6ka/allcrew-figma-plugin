/**
 * Pixel dimensions of an image from its own header bytes.
 *
 * `Image.getSizeAsync()` is the API for this, and in practice it never settled for a fill
 * on a live file — every caller stalled on it. The dimensions are in the first few dozen bytes
 * of any format Figma stores, so reading them here costs nothing and cannot hang. Unknown or
 * truncated data answers zeros rather than throwing: the caller still has the bytes.
 */
export interface ImageDimensions {
  width: number
  height: number
}

const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)

export function imageDimensions(bytes: Uint8Array): ImageDimensions {
  const none = { width: 0, height: 0 }
  if (bytes.length < 24) return none

  // PNG: signature, then IHDR with width and height as big-endian 32-bit.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: be32(bytes, 16), height: be32(bytes, 20) }
  }

  // GIF: "GIF8", then the logical screen size as little-endian 16-bit.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { width: le16(bytes, 6), height: le16(bytes, 8) }
  }

  // WebP: RIFF container; the first chunk says which bitstream and carries the size.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === 'VP8 ' && bytes.length >= 30) return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X' && bytes.length >= 30) return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
    return none
  }

  // JPEG: walk the segments to the first start-of-frame; height then width, big-endian 16-bit.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1
        continue
      }
      const marker = bytes[at + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2
        continue
      }
      const length = be16(bytes, at + 2)
      const isFrame = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { width: be16(bytes, at + 7), height: be16(bytes, at + 5) }
      at += 2 + length
    }
  }
  return none
}

/**
 * Whether an image can carry transparency, from the same header bytes.
 *
 * `alpha` is the difference between a photograph and a cut-out figure, and it decides how the
 * picture is placed: a photo is a `cover` fill under a scrim, a cut-out sits in a corner of a
 * card. Nothing in the Plugin API says which one a paint holds - the answer is in the file, and
 * the file is already in the caller's hands whenever this matters.
 *
 * It reports what the FORMAT carries, not what the pixels use: an RGBA PNG whose alpha is 255
 * everywhere still answers `alpha`. Deciding otherwise needs a full decode, which the sandbox
 * cannot afford - and this is the harmless direction, since a consumer that treats an opaque
 * RGBA image as a cut-out simply draws it whole.
 */
export type ImageAlpha = 'none' | 'alpha' | 'unknown'

export function imageAlpha(bytes: Uint8Array): ImageAlpha {
  if (bytes.length < 26) return 'unknown'

  // PNG: IHDR's colour type - 4 (grey+alpha) and 6 (RGBA) carry a channel; 3 (palette) carries
  // transparency only if a tRNS chunk follows, which is exactly how a palette cut-out is stored.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const colourType = bytes[25]
    if (colourType === 4 || colourType === 6) return 'alpha'
    if (colourType === 3) return hasPngChunk(bytes, 'tRNS') ? 'alpha' : 'none'
    return 'none'
  }

  // JPEG has no alpha at all, in any variant - the one format where the answer is free.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'none'

  // WebP: the extended container states it in a flag, lossless keeps it in its own header bit,
  // and plain lossy VP8 never has it.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === 'VP8X') return (bytes[20] & 0x10) !== 0 ? 'alpha' : 'none'
    if (chunk === 'VP8L') return (bytes[24] & 0x10) !== 0 ? 'alpha' : 'none'
    if (chunk === 'VP8 ') return 'none'
    return 'unknown'
  }

  // GIF keeps transparency in a graphic-control extension anywhere in the stream, so the header
  // alone cannot answer. Saying so beats guessing on a format Figma fills rarely hold.
  return 'unknown'
}

/** Whether a named chunk appears in a PNG, walking the length-prefixed chain from the signature. */
function hasPngChunk(bytes: Uint8Array, name: string): boolean {
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = be32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    if (type === name) return true
    // Past the pixel data a tRNS chunk is invalid, so there is nothing left to find.
    if (type === 'IDAT' || type === 'IEND') return false
    at += 12 + length
  }
  return false
}
