import { z } from 'zod'

import { ErrorCode } from '../common/errors.js'
import { OPERATION_SCOPES } from '../common/principal.js'

// Every field is required unless noted: the registry refuses an operation that skips one
export const waOperationSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, 'a dotted id such as chats.setState'),
    scope: z.enum(OPERATION_SCOPES),
    summary: z.string().trim().min(1),
    description: z.string().trim().min(1),
    // Without it the operation is REST-only; with it, exposed as a socket command too; the command name is unique across the registry
    socket: z
      .strictObject({ command: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/) })
      .optional(),
    errors: z.array(z.enum(ErrorCode)),
    // `null` for an operation without a body
    examples: z.strictObject({ request: z.json(), response: z.json() }),
    // Parity links ('Chat.sendStateTyping'); empty only when `gateway` is true
    wwebjs: z.array(z.string().regex(/^\w+\.\w+$/)),
    // Gateway-native operation with no wwebjs counterpart
    gateway: z.boolean().optional()
  })
  .refine(op => (op.gateway === true ? op.wwebjs.length === 0 : op.wwebjs.length > 0), {
    path: ['wwebjs'],
    message: 'list at least one wwebjs symbol, or declare gateway: true with an empty list'
  })

export type WaOperationMeta = z.infer<typeof waOperationSchema>
