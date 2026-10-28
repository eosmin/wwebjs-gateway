import type { StoredMessage } from '../database/models.js'
import type { NewStoredMessage } from '../database/repositories/messages.repository.js'
import { MessageDto } from '../types/dto.js'

// What the row keeps of a message. Without bodies the text and the raw copy (which repeats it) are
// left out of the stored DTO, so a message replayed after a crash comes back without its text.
export function toNewStoredMessage(
  sessionId: string,
  message: MessageDto,
  storeBodies: boolean
): NewStoredMessage {
  const dto = storeBodies ? message : { ...message, body: '', raw: undefined }
  return {
    id: message.id,
    sessionId,
    chatId: message.chatId,
    direction: message.fromMe ? 'out' : 'in',
    fromMe: message.fromMe,
    type: message.type,
    body: storeBodies ? message.body : null,
    hasMedia: message.hasMedia,
    ack: message.ack,
    sentAt: new Date(message.sentAt),
    receivedAt: new Date(message.receivedAt),
    ...(message.origin && { origin: message.origin }),
    // The DTO was built by the mappers; JSON round trip drops the `undefined` keys Prisma refuses
    dto: JSON.parse(JSON.stringify(dto)) as NewStoredMessage['dto']
  }
}

// undefined when the stored JSON no longer fits the DTO (written by another version of the gateway)
export function toMessageDto(row: StoredMessage): MessageDto | undefined {
  const parsed = MessageDto.safeParse(row.dto)
  return parsed.success ? parsed.data : undefined
}
