// The deadline the WhatsApp adapter gives the calls that take long (sending and moving media, the
// operations whose time grows with their input, TDD §6.3). The HTTP backstop must wait longer than it.
export const LONG_CALL_TIMEOUT_MS = 180_000
