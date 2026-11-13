// A media type as a sender writes it (`audio/ogg; codecs=opus`, `Image/PNG`): checked against the
// grammar of RFC 9110 and reduced to its bare type. What follows the first `;` is the sender's, so it
// is never stored, served or sent on; the one exception is the codec of a voice note, which comes
// from a constant below.

const MAX_MEDIA_TYPE_LENGTH = 200
const TOKEN = "[a-z0-9!#$%&'*+.^_`|~-]+"
// A quoted value: no escapes, no control characters
const QUOTED = '"[^"\\\\\\u0000-\\u001f\\u007f]*"'
const MEDIA_TYPE = new RegExp(
  `^(${TOKEN}/${TOKEN})((?:\\s*;\\s*${TOKEN}=(?:${TOKEN}|${QUOTED}))*)$`
)
const PARAMETER = new RegExp(`;\\s*(${TOKEN})=(${TOKEN}|${QUOTED})`, 'g')
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface ParsedMediaType {
  // `type/subtype` in lower case
  bare: string
  // Name and value in lower case, without the quotes of a quoted value
  parameters: [string, string][]
}

// The bare type and the parameters, or undefined when the value is not a well formed media type
// (a stray `;`, a line break or any control character, junk, more than 200 characters). Case and
// the spaces around the value are not part of the type.
export function parseMediaType(value: string): ParsedMediaType | undefined {
  if (typeof value !== 'string' || value.length > MAX_MEDIA_TYPE_LENGTH) return undefined
  if (CONTROL_CHARACTERS.test(value)) return undefined
  const match = MEDIA_TYPE.exec(value.trim().toLowerCase())
  const bare = match?.[1]
  if (bare === undefined) return undefined
  const parameters: [string, string][] = []
  for (const [, name, raw] of (match?.[2] ?? '').matchAll(PARAMETER)) {
    if (name === undefined || raw === undefined) continue
    parameters.push([name, raw.startsWith('"') ? raw.slice(1, -1) : raw])
  }
  return { bare, parameters }
}

// What a voice note needs to be one: WhatsApp calls it `audio/ogg; codecs=opus`
const VOICE_NOTE_TYPE = 'audio/ogg; codecs=opus'

// The type to store, send to WhatsApp or serve: the bare type in lower case, with the parameters of
// the sender left out. A voice note (`audio/ogg` whose `codecs` parameter is exactly `opus`) gets its
// codec from a constant, never from the value of the sender. Undefined when it is not well formed.
export function outgoingMediaType(value: string): string | undefined {
  const parsed = parseMediaType(value)
  if (parsed === undefined) return undefined
  const opus = parsed.parameters.some(
    ([name, parameter]) => name === 'codecs' && parameter === 'opus'
  )
  return parsed.bare === 'audio/ogg' && opus ? VOICE_NOTE_TYPE : parsed.bare
}
