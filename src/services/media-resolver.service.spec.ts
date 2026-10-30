import { NotFoundError, PayloadTooLargeError, ValidationError } from '../common/errors.js'
import * as download from '../common/lib/public-download.js'
import type { AppConfig } from '../config/env.schema.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { MediaResolverService } from './media-resolver.service.js'

const config = {
  MAX_MEDIA_BYTES: 12,
  MEDIA_FETCH_CONCURRENCY: 2,
  MEDIA_FETCH_TIMEOUT_MS: 5000,
  WEBHOOK_PRIVATE_HOST_ALLOWLIST: ['media.internal'],
  ALLOW_PRIVATE_WEBHOOK_TARGETS: false
} as unknown as AppConfig

function build(downloadMedia = jest.fn()) {
  const sessions = {
    requireReady: () => ({ downloadMedia }) as unknown as WhatsAppClientPort
  } as unknown as SessionManager
  return new MediaResolverService(config, sessions)
}

describe('MediaResolverService', () => {
  afterEach(() => jest.restoreAllMocks())

  it('passes valid inline base64 through', async () => {
    const media = await build().resolve('s', {
      base64: Buffer.from('hello').toString('base64'),
      mimetype: 'text/plain',
      filename: 'a.txt'
    })

    expect(media).toEqual({ mimetype: 'text/plain', data: 'aGVsbG8=', filename: 'a.txt' })
  })

  it('refuses inline media above MAX_MEDIA_BYTES, measured after decoding', async () => {
    await expect(
      build().resolve('s', { base64: Buffer.alloc(40).toString('base64'), mimetype: 'a/b' })
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it.each([
    ['exactly the cap', 12, true],
    ['one byte over it', 13, false],
    ['a size that needs padding, within the cap', 10, true],
    ['a size that needs padding, over the cap', 14, false]
  ])('measures the cap on the decoded bytes: %s', async (_label, bytes, accepted) => {
    const result = build().resolve('s', {
      base64: Buffer.alloc(bytes, 1).toString('base64'),
      mimetype: 'a/b'
    })

    if (accepted) await expect(result).resolves.toMatchObject({ mimetype: 'a/b' })
    else await expect(result).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('refuses text that is not base64', async () => {
    await expect(
      build().resolve('s', { base64: 'not base64!', mimetype: 'a/b' })
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('downloads a URL with the policy, the cap and the timeout of the configuration', async () => {
    const spy = jest
      .spyOn(download, 'downloadPublicFile')
      .mockResolvedValue({ data: Buffer.from('hello'), contentType: 'image/png' })

    const media = await build().resolve('s', {
      url: 'https://cdn.example.com/a',
      filename: 'x.png'
    })

    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/a', {
      policy: { privateHostAllowlist: ['media.internal'], allowPrivate: false },
      maxBytes: 12,
      timeoutMs: 5000
    })
    expect(media).toEqual({ mimetype: 'image/png', data: 'aGVsbG8=', filename: 'x.png' })
  })

  it('sniffs the type of a download whose server says nothing', async () => {
    jest.spyOn(download, 'downloadPublicFile').mockResolvedValue({
      data: Buffer.from('%PDF-1.7 ...'),
      contentType: undefined
    })

    const media = await build().resolve('s', { url: 'https://cdn.example.com/a' })

    expect(media.mimetype).toBe('application/pdf')
  })

  it('fails when nothing says what the downloaded file is', async () => {
    jest
      .spyOn(download, 'downloadPublicFile')
      .mockResolvedValue({ data: Buffer.from('????'), contentType: undefined })

    await expect(build().resolve('s', { url: 'https://cdn.example.com/a' })).rejects.toMatchObject({
      code: 'MEDIA_FETCH_FAILED'
    })
  })

  it('refuses the media of another message when it is larger than the cap', async () => {
    const downloadMedia = jest
      .fn()
      .mockResolvedValue({ mimetype: 'video/mp4', data: Buffer.alloc(40).toString('base64') })

    await expect(build(downloadMedia).resolve('s', { messageId: 'm1' })).rejects.toBeInstanceOf(
      PayloadTooLargeError
    )
  })

  it('lets the errors of the download through unchanged', async () => {
    const blocked = new ValidationError('VALIDATION_ERROR', 'The URL is not allowed')
    jest.spyOn(download, 'downloadPublicFile').mockRejectedValue(blocked)

    await expect(build().resolve('s', { url: 'http://169.254.169.254/' })).rejects.toBe(blocked)
  })

  it('makes the media of other messages take their turn with the downloads', async () => {
    let running = 0
    let peak = 0
    const downloadMedia = jest.fn(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 10))
      running -= 1
      return { mimetype: 'image/png', data: 'QUJD' }
    })
    const resolver = build(downloadMedia)

    await Promise.all(
      Array.from({ length: 6 }, (_, n) => resolver.resolve('s', { messageId: `m${n}` }))
    )

    expect(peak).toBe(2)
  })

  it('downloads no more than MEDIA_FETCH_CONCURRENCY files at once', async () => {
    let running = 0
    let peak = 0
    jest.spyOn(download, 'downloadPublicFile').mockImplementation(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 10))
      running -= 1
      return { data: Buffer.from('x'), contentType: 'image/png' }
    })
    const resolver = build()

    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        resolver.resolve('s', { url: `https://cdn.example.com/${n}` })
      )
    )

    expect(peak).toBe(2)
  })

  it('reuses the media of another message, and 404s when it is gone', async () => {
    const downloadMedia = jest
      .fn()
      .mockResolvedValueOnce({ mimetype: 'image/jpeg', data: 'QUJD', filename: null })
      .mockResolvedValueOnce(null)
    const resolver = build(downloadMedia)

    await expect(resolver.resolve('s', { messageId: 'm1' })).resolves.toEqual({
      mimetype: 'image/jpeg',
      data: 'QUJD'
    })
    await expect(resolver.resolve('s', { messageId: 'm2' })).rejects.toBeInstanceOf(NotFoundError)
  })
})
