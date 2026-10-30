const hex = (...bytes: number[]): Buffer => Buffer.from(bytes)

// The first bytes of the formats WhatsApp sends as media. A server that says nothing useful
// (`application/octet-stream`, a missing header) is believed no more than the file itself.
const SIGNATURES: readonly { mimetype: string; offset: number; bytes: Buffer }[] = [
  { mimetype: 'image/jpeg', offset: 0, bytes: hex(0xff, 0xd8, 0xff) },
  { mimetype: 'image/png', offset: 0, bytes: hex(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { mimetype: 'image/gif', offset: 0, bytes: Buffer.from('GIF8') },
  { mimetype: 'application/pdf', offset: 0, bytes: Buffer.from('%PDF-') },
  { mimetype: 'audio/ogg', offset: 0, bytes: Buffer.from('OggS') },
  { mimetype: 'audio/mpeg', offset: 0, bytes: Buffer.from('ID3') },
  { mimetype: 'video/mp4', offset: 4, bytes: Buffer.from('ftyp') }
]

const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])

function sniffMimetype(data: Buffer): string | undefined {
  const known = SIGNATURES.find(({ offset, bytes }) =>
    data.subarray(offset, offset + bytes.length).equals(bytes)
  )
  if (known) return known.mimetype
  // RIFF....WEBP
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

// type/subtype with the characters of RFC 6838: the value travels in headers and to WhatsApp
const MIME_SHAPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/

// The ISO base media box (`ftyp`) holds video, audio-only m4a and HEIC images alike, so on its own it
// says nothing against a declared audio, video or image type
const AMBIGUOUS_CONTAINERS: ReadonlySet<string> = new Set(['video/mp4'])
const CONTAINER_FAMILIES: ReadonlySet<string> = new Set(['audio', 'video', 'image'])

const topLevel = (mimetype: string): string => mimetype.slice(0, mimetype.indexOf('/'))

// What to tell WhatsApp the file is. The server's Content-Type is believed when it is well formed,
// specific, and does not contradict the bytes (a server that says text/html for a PNG is lying or
// wrong); otherwise what the bytes look like. Two subtypes of the same family (audio/mp4 and video/mp4
// share a box) keep the server's answer.
export function resolveMimetype(contentType: string | undefined, data: Buffer): string | undefined {
  const wellFormed =
    contentType !== undefined && MIME_SHAPE.test(contentType) ? contentType : undefined
  const sniffed = sniffMimetype(data)
  // Nothing specific was declared: the bytes, or the generic type for a file nobody can name
  if (wellFormed === undefined || GENERIC_TYPES.has(wellFormed)) return sniffed ?? wellFormed
  if (sniffed === undefined || topLevel(sniffed) === topLevel(wellFormed)) return wellFormed
  const unsure = AMBIGUOUS_CONTAINERS.has(sniffed) && CONTAINER_FAMILIES.has(topLevel(wellFormed))
  return unsure ? wellFormed : sniffed
}
