import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'

import { ValidationError } from '../common/errors.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import {
  MessagesRepository,
  type StoredMessageCursor
} from '../database/repositories/messages.repository.js'
import type { MessageDto } from '../types/dto.js'
import { toMessageDto } from '../whatsapp/event-pipeline.storage.js'

const MS_PER_DAY = 24 * 3600 * 1000

export interface StoredMessagesQuery {
  sessionId: string
  chatId?: string
  // The `nextCursor` of the previous page
  cursor?: string
  limit: number
}

export interface StoredMessagesPage {
  items: MessageDto[]
  // Null on the last page
  nextCursor: string | null
}

const CursorPayload = z.strictObject({ sentAt: z.iso.datetime(), id: z.string().min(1) })

const encodeCursor = (cursor: StoredMessageCursor): string =>
  Buffer.from(JSON.stringify({ sentAt: cursor.sentAt.toISOString(), id: cursor.id })).toString(
    'base64url'
  )

function decodeCursor(cursor: string): StoredMessageCursor {
  const invalid = new ValidationError('VALIDATION_ERROR', 'The cursor is not valid')
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  const parsed = CursorPayload.safeParse(json)
  if (!parsed.success) throw invalid
  return { sentAt: new Date(parsed.data.sentAt), id: parsed.data.id }
}

// What the gateway keeps of the messages it saw (TDD §5.3): the read side behind
// `GET …/stored-messages` and the purge the retention job runs. The writes belong to the event
// pipeline, which stores each message before it is published.
@Injectable()
export class MessageStoreService {
  private readonly logger = new Logger(MessageStoreService.name)

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository
  ) {}

  // Newest first. The cursor is taken from the last row read, so a row that cannot be turned into a
  // message (written by another version of the gateway) is left out without stopping the paging.
  async list(query: StoredMessagesQuery): Promise<StoredMessagesPage> {
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
    // One more than asked: its existence is what tells there is another page
    const rows = await this.messages.listStored({
      sessionId: query.sessionId,
      ...(query.chatId !== undefined && { chatId: query.chatId }),
      ...(before && { before }),
      limit: query.limit + 1
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    const items: MessageDto[] = []
    for (const row of page) {
      const message = toMessageDto(row)
      if (message) items.push(message)
      else this.logger.warn(`Stored message ${row.id} of session ${query.sessionId} is unreadable`)
    }
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ sentAt: last.sentAt, id: last.id })
          : null
    }
  }

  // Deletes what is older than MESSAGE_RETENTION_DAYS; the repository keeps the incoming messages
  // that were never published. Returns how many rows went.
  purgeExpired(now: Date = new Date()): Promise<number> {
    return this.messages.deleteOlderThan(
      new Date(now.getTime() - this.config.MESSAGE_RETENTION_DAYS * MS_PER_DAY)
    )
  }
}
