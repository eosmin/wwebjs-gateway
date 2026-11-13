import { parseMediaType } from './media-type.js'

// What the media endpoint may show inline. The sender of a message chooses its type and its bytes, so
// only formats a browser shows without running anything are served inline, and only under the bare
// type: the parameters the sender wrote (`; codecs=opus`) never reach the response header.
const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'audio/ogg',
  'audio/mpeg',
  'application/pdf'
])

// The bare type to serve the media under, or undefined when it must be a download of opaque bytes:
// the type is not a well-formed media type (a line break, a stray `;`, junk), or its bare type is not
// one of the inline formats. Case and surrounding spaces are not part of the type.
export function inlineMediaType(mimetype: string): string | undefined {
  const bare = parseMediaType(mimetype)?.bare
  return bare !== undefined && INLINE_MEDIA_TYPES.has(bare) ? bare : undefined
}
