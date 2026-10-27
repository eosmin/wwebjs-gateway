import { autoTypingMs, resolveTypingMs, TYPING_RENEW_MS, typingSegments } from './humanize.js'

describe('autoTypingMs', () => {
  it('scales with the body length, 35 ms per character', () => {
    expect(autoTypingMs(100, () => 0.5)).toBe(3500)
  })

  it('applies up to ±20 % jitter', () => {
    expect(autoTypingMs(100, () => 0)).toBe(2800)
    expect(autoTypingMs(100, () => 1)).toBe(4200)
  })

  it('stays between 600 ms and 8 s', () => {
    expect(autoTypingMs(1, () => 0.5)).toBe(600)
    expect(autoTypingMs(0, () => 0.5)).toBe(600)
    expect(autoTypingMs(10_000, () => 1)).toBe(8000)
  })
})

describe('resolveTypingMs', () => {
  it('computes auto from the body and passes explicit durations through', () => {
    expect(resolveTypingMs('auto', 100, () => 0.5)).toBe(3500)
    expect(resolveTypingMs(1234, 100)).toBe(1234)
    expect(resolveTypingMs(-5, 100)).toBe(0)
  })
})

describe('typingSegments', () => {
  it('splits a long wait at every renewal', () => {
    expect(typingSegments(45_000)).toEqual([TYPING_RENEW_MS, TYPING_RENEW_MS, 5000])
  })

  it('keeps a short wait whole and an empty one empty', () => {
    expect(typingSegments(3000)).toEqual([3000])
    expect(typingSegments(0)).toEqual([])
  })
})
