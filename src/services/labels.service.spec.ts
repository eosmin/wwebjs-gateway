import { NotFoundError, ValidationError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { LabelsService } from './labels.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const LABELS = [
  { id: '1', name: 'Nuevo', hexColor: '#ff9485' },
  { id: '3', name: 'Pagado', hexColor: '#64c4ff' }
]

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => ({ getLabels: ok(LABELS), ...client }))
  return {
    service: new LabelsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}

describe('LabelsService reads', () => {
  it('lists the labels through the client of a ready session', async () => {
    const { service, requireReady } = build({})

    await expect(service.list('s')).resolves.toEqual(LABELS)
    expect(requireReady).toHaveBeenCalledWith('s')
  })

  it('does not call the client when the session is not ready', () => {
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new LabelsService({ requireReady } as unknown as SessionManager)

    expect(() => service.list('s')).toThrow('not ready')
  })

  it('reads a label that exists', async () => {
    const getLabelById = ok(LABELS[0])
    const { service } = build({ getLabelById })

    await expect(service.get('s', '1')).resolves.toEqual(LABELS[0])
    expect(getLabelById).toHaveBeenCalledWith('1')
  })

  it('answers NOT_FOUND for a label the account lacks, without asking the page for it', async () => {
    const getLabelById = ok()
    const getChatsByLabelId = ok([])
    const { service } = build({ getLabelById, getChatsByLabelId })

    await expect(service.get('s', '9')).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.chats('s', '9')).rejects.toBeInstanceOf(NotFoundError)
    expect(getLabelById).not.toHaveBeenCalled()
    expect(getChatsByLabelId).not.toHaveBeenCalled()
  })

  it('lists the chats of a label that exists', async () => {
    const getChatsByLabelId = ok([{ id: 'a@c.us' }])
    const { service } = build({ getChatsByLabelId })

    await expect(service.chats('s', '3')).resolves.toEqual([{ id: 'a@c.us' }])
    expect(getChatsByLabelId).toHaveBeenCalledWith('3')
  })

  it('checks the chat before it reads its labels', async () => {
    const getChatById = jest.fn(() => Promise.reject(new Error('CHAT_NOT_FOUND')))
    const getChatLabels = ok([LABELS[0]])
    const { service } = build({ getChatById, getChatLabels })

    await expect(service.ofChat('s', 'x@c.us')).rejects.toThrow('CHAT_NOT_FOUND')
    expect(getChatLabels).not.toHaveBeenCalled()
  })

  it('reads the labels of a chat that exists', async () => {
    const getChatLabels = ok([LABELS[0]])
    const { service } = build({ getChatById: ok({}), getChatLabels })

    await expect(service.ofChat('s', 'a@c.us')).resolves.toEqual([LABELS[0]])
    expect(getChatLabels).toHaveBeenCalledWith('a@c.us')
  })
})

describe('LabelsService actions', () => {
  it('sets the labels of the chats once the labels and the chats are known', async () => {
    const getChatById = ok({})
    const addOrRemoveLabels = ok()
    const { service } = build({ getChatById, addOrRemoveLabels })

    await service.assign('s', ['1', '3'], ['a@c.us', 'b@g.us'])

    expect(getChatById).toHaveBeenCalledTimes(2)
    expect(addOrRemoveLabels).toHaveBeenCalledWith(['1', '3'], ['a@c.us', 'b@g.us'])
  })

  it('sets the labels of one chat', async () => {
    const addOrRemoveLabels = ok()
    const { service } = build({ getChatById: ok({}), addOrRemoveLabels })

    await service.setForChat('s', 'a@c.us', ['1'])

    expect(addOrRemoveLabels).toHaveBeenCalledWith(['1'], ['a@c.us'])
  })

  it('clears the labels with an empty list, without reading the labels of the account', async () => {
    const getLabels = ok(LABELS)
    const addOrRemoveLabels = ok()
    const { service } = build({ getLabels, getChatById: ok({}), addOrRemoveLabels })

    await service.assign('s', [], ['a@c.us'])

    expect(getLabels).not.toHaveBeenCalled()
    expect(addOrRemoveLabels).toHaveBeenCalledWith([], ['a@c.us'])
  })

  it('refuses an unknown label by name and changes nothing', async () => {
    const addOrRemoveLabels = ok()
    const getChatById = ok({})
    const { service } = build({ addOrRemoveLabels, getChatById })

    const failure = service.assign('s', ['1', '8', '9'], ['a@c.us'])

    await expect(failure).rejects.toBeInstanceOf(ValidationError)
    await expect(failure).rejects.toThrow('8, 9')
    expect(getChatById).not.toHaveBeenCalled()
    expect(addOrRemoveLabels).not.toHaveBeenCalled()
  })

  it('changes nothing when one of the chats does not exist', async () => {
    const getChatById = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('CHAT_NOT_FOUND'))
    const addOrRemoveLabels = ok()
    const { service } = build({ getChatById, addOrRemoveLabels })

    await expect(service.assign('s', ['1'], ['a@c.us', 'x@c.us'])).rejects.toThrow('CHAT_NOT_FOUND')
    expect(addOrRemoveLabels).not.toHaveBeenCalled()
  })
})
