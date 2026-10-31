# Lookup

Two read-only routes under `/v1/sessions/:sessionId` that tell who a phone number or an id is, without sending anything (TDD §6.11). Each one needs the `read` scope and, when WhatsApp has to be asked, a session that is `ready` (`409 SESSION_NOT_READY` otherwise).

| Operation           | Route                          | Answer                                              |
| ------------------- | ------------------------------ | --------------------------------------------------- |
| `numbers.lookup`    | `GET …/numbers/:number`        | `{ number, registered, id, countryCode, formatted }` |
| `contacts.lidPhone` | `GET …/contacts/lid-phone?ids=` | `{ items: [{ lid, pn }] }`                          |

## `numbers.lookup`

`:number` is a phone number of 7 to 15 digits; a leading `+` (write it `%2B` in a URL), spaces, dashes, dots and parentheses are accepted and removed. Anything else, a WhatsApp id included, is `400 VALIDATION_ERROR`.

- A number with an account answers `registered: true` with its WhatsApp `id`, the calling code of its country (`971`, `52`, `1`; not an ISO region) and the number as WhatsApp writes it (international format with the `+`, for example `+971 50 000 0001`). The `id` is the one WhatsApp answers with: with a real account it was a `@lid` (`100000000000001@lid`), not the `@c.us` of the number, so do not build the chat id from the number; use this `id`.
- A number without one answers **`200` with `registered: false`** and `null` in the other three fields. It is an answer, not an error (the send routes turn the same fact into `422 NUMBER_NOT_ON_WHATSAPP`). The country code and the format are not asked for it.
- The look-up is the one the send routes use, so the cache is shared: a registered number is remembered for an hour, one that is not for five minutes, by every session. A cached answer costs nothing.
- A look-up that is not cached counts against `LOOKUPS_PER_DAY` of the session (TDD §6.8.1): many look-ups of numbers that are not on WhatsApp are a signal to WhatsApp in themselves. Past the budget the answer is `422 POLICY_BLOCKED` with `details.rule`.
- A `registered: false` is WhatsApp's answer at that moment: WhatsApp Web can answer "no" wrongly while it is busy, and the answer is then kept five minutes. Ask again later before treating it as final.
- Covers `Client.getNumberId` and `Client.isRegisteredUser` (the same fact), `Client.getCountryCode` and `Client.getFormattedNumber`.

## `contacts.lidPhone`

WhatsApp identifies some users by a `@lid` id that hides the phone number. `ids` is one comma-separated value of up to 50 ids, each ending in `@c.us` or `@lid` (anything else is `400`); repeated ids are asked once. WhatsApp answers the pair `{ lid, pn }` of each id. The side it does not know comes as `null`: the `pn` of a `@lid` that hides its phone, the `lid` of a phone it has no `@lid` for. An id about which it knows nothing at all is left out, so `items` can be shorter than the list. Seen with a real account: a `@lid` and a `@c.us` of the same contact give the same pair. Covers `Client.getContactLidAndPhone`.
