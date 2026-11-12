import type { FastifyReply } from 'fastify'

import type { SendResult } from '../../services/message-send.service.js'
import { MessageDto } from '../../types/dto.js'

import { readableMessage, sendAnswer } from './send-answer.js'

const reply = { header: jest.fn(), status: jest.fn() } as unknown as FastifyReply

// A message the schema does not accept (a field of the wrong type)
const broken = { id: 'true_x_1', body: 42 } as unknown as MessageDto

describe('a send whose message cannot be read back', () => {
  const sent = (message: MessageDto): SendResult => ({
    jobId: 'idem-1',
    replayed: false,
    outcome: { ok: true, message }
  })

  it('still answers sent, without the message, instead of hiding that the message went out', () => {
    const answer = sendAnswer(sent(broken), reply)

    expect(answer).toEqual({ jobId: 'idem-1', status: 'sent' })
  })

  it('keeps a message that fits its schema', () => {
    const ok = { chatId: 'c' } as unknown as MessageDto
    jest.spyOn(MessageDto, 'safeParse').mockReturnValueOnce({ success: true, data: ok })

    expect(sendAnswer(sent(ok), reply)).toEqual({ jobId: 'idem-1', status: 'sent', message: ok })
  })

  it('drops the broken message of a job read later too', () => {
    expect(readableMessage({ jobId: 'j', status: 'sent', message: broken })).toEqual({
      jobId: 'j',
      status: 'sent'
    })
  })
})
