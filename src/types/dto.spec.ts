import { z } from 'zod'

import { exampleOf } from '../../scripts/lib/json-schema-example.js'

import * as dto from './dto.js'

const SCHEMAS: [string, z.ZodObject][] = []
for (const [name, value] of Object.entries(dto)) {
  if (value instanceof z.ZodObject) SCHEMAS.push([name, value])
}

function exampleFor(schema: z.ZodType): unknown {
  const { $defs, ...top } = z.toJSONSchema(schema) as z.core.JSONSchema.JSONSchema
  return exampleOf(top, $defs ?? {})
}

describe('the DTO schemas', () => {
  it('are the 27 of TDD §6.6 and the pieces they are made of', () => {
    expect(SCHEMAS.map(([name]) => name).sort()).toEqual(
      [
        'BatteryInfoDto',
        'BroadcastDto',
        'BusinessContactDto',
        'BusinessProfileDto',
        'CallDto',
        'ChannelDto',
        'ChatDto',
        'ClientInfoDto',
        'ContactDto',
        'GroupChatDto',
        'GroupNotificationDto',
        'GroupParticipantDto',
        'InviteV4Dto',
        'LabelDto',
        'LocationDto',
        'MembershipRequestDto',
        'MessageDto',
        'MessageInfoDto',
        'MessageMediaDto',
        'OrderDto',
        'OrderingDto',
        'OriginDto',
        'PaymentDto',
        'PollVoteDto',
        'ProductDto',
        'ReactionDto',
        'ReactionListDto'
      ].sort()
    )
  })

  it.each(SCHEMAS)('%s is named by its own id in the docs', (name, schema) => {
    expect(z.globalRegistry.get(schema)?.id).toBe(name)
  })

  it.each(SCHEMAS)('%s accepts the minimal value built from it', (_name, schema) => {
    expect(schema.safeParse(exampleFor(schema)).error?.issues).toBeUndefined()
  })

  it.each(SCHEMAS)('%s rejects an empty object', (_name, schema) => {
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe('MessageDto', () => {
  const minimal = dto.MessageDto.parse(exampleFor(dto.MessageDto))

  it('adds the gateway fields to those of wwebjs', () => {
    for (const field of ['chatId', 'sentAt', 'receivedAt', 'ordering', 'origin', 'media', 'raw']) {
      expect(dto.MessageDto.shape).toHaveProperty(field)
    }
  })

  it('keeps the dates as ISO strings', () => {
    expect(dto.MessageDto.safeParse({ ...minimal, sentAt: 1_700_000_000 }).success).toBe(false)
    expect(dto.MessageDto.safeParse({ ...minimal, receivedAt: 'yesterday' }).success).toBe(false)
  })

  it('takes the origin of a Click-to-WhatsApp ad and nothing else', () => {
    const origin = { kind: 'click_to_whatsapp_ad', sourceId: '120210000000000000' }

    expect(dto.MessageDto.safeParse({ ...minimal, origin }).success).toBe(true)
    expect(dto.MessageDto.safeParse({ ...minimal, origin: { kind: 'organic' } }).success).toBe(
      false
    )
  })

  it('lets the media carry base64 only as an option', () => {
    const media = { mimetype: 'image/png', downloadUrl: 'https://gw.test/media/1' }

    expect(dto.MessageDto.safeParse({ ...minimal, media }).success).toBe(true)
    expect(dto.MessageDto.safeParse({ ...minimal, media: { mimetype: 'image/png' } }).success).toBe(
      false
    )
  })
})

describe('SessionStatus', () => {
  it('is the nine statuses of TDD §5.2, in the order of the machine', () => {
    expect(dto.SESSION_STATUSES).toEqual([
      'created',
      'starting',
      'qr',
      'pairing_code',
      'authenticating',
      'ready',
      'disconnected',
      'stopped',
      'failed'
    ])
    expect(dto.SessionStatus.options).toEqual([...dto.SESSION_STATUSES])
  })
})
