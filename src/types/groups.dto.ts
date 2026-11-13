import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isWaId } from '../common/lib/wa-id.js'

import { GroupChatDto, MembershipRequestDto, MessageDto } from './dto.js'
import { MediaSource } from './messages.dto.js'
import { SessionId } from './sessions.dto.js'

// WhatsApp limits: a subject has 100 characters, a description 2048, and a group 1024 members
export const MAX_GROUP_SUBJECT_LENGTH = 100
export const MAX_GROUP_DESCRIPTION_LENGTH = 2048
// One call adds or removes this many at most: wwebjs pauses between participants, so a long list
// holds the session's client for minutes
export const MAX_PARTICIPANTS_PER_CALL = 256

const GroupId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(value => isWaId(value) && value.endsWith('@g.us'), {
    message: 'must be a group id ending in @g.us'
  })
  .describe('Serialized id of the group, such as 120363000000000001@g.us')

const UserId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(value => isWaId(value) && /@(c\.us|lid)$/.test(value), {
    message: 'must be a user id ending in @c.us or @lid'
  })
  .describe('Serialized id of a user, such as 5215500000001@c.us or 100000000000001@lid')

const InviteCode = z
  .string()
  .trim()
  .regex(/^[\w-]{10,64}$/, 'must be the code of an invite link, not the whole link')
  .describe('The code at the end of https://chat.whatsapp.com/<code>')

const Participants = z
  .array(UserId)
  .min(1)
  .max(MAX_PARTICIPANTS_PER_CALL)
  .refine(ids => new Set(ids).size === ids.length, { message: 'repeats a participant' })

// Milliseconds wwebjs waits between two participants: a number, or a [min, max] range to pick from.
// The pauses of one call must fit the long-call timeout of the adapter (180 s), or the call would
// time out while wwebjs goes on and the outcome would be unknown.
export const MAX_SLEEP_MS = 5000
export const MAX_PAUSES_MS = 120_000
const SleepValue = z.number().int().min(0).max(MAX_SLEEP_MS)
const Sleep = z
  .union([
    SleepValue,
    z.tuple([SleepValue, SleepValue]).refine(([min, max]) => min <= max, {
      message: 'the range must be [min, max] with min <= max'
    })
  ])
  .describe('Pause between participants in ms, or a [min, max] range; wwebjs defaults to 250-500')

const longestPause = (sleep: number | [number, number] | undefined): number =>
  sleep === undefined ? 0 : typeof sleep === 'number' ? sleep : sleep[1]
const fitsTimeout = (count: number, sleep: number | [number, number] | undefined): boolean =>
  count * longestPause(sleep) <= MAX_PAUSES_MS

// ---- Params ------------------------------------------------------------------------------------

export const SessionGroupParams = z.strictObject({ sessionId: SessionId, groupId: GroupId })
export class SessionGroupParamsDto extends createZodDto(SessionGroupParams) {}

export const SessionInviteParams = z.strictObject({ sessionId: SessionId, inviteCode: InviteCode })
export class SessionInviteParamsDto extends createZodDto(SessionInviteParams) {}

// ---- Bodies ------------------------------------------------------------------------------------

const Subject = z
  .string()
  .trim()
  .min(1)
  .max(MAX_GROUP_SUBJECT_LENGTH)
  .describe(`The name of the group, up to ${MAX_GROUP_SUBJECT_LENGTH} characters`)

export const CreateGroupBody = z
  .strictObject({
    subject: Subject,
    participants: Participants.describe(
      'Who is added; the account itself is the creator and is not listed'
    ),
    messageTimer: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Seconds before the messages disappear; 0 or absent keeps them'),
    parentGroupId: GroupId.optional().describe('The community the group belongs to'),
    autoSendInviteV4: z
      .boolean()
      .optional()
      .describe(
        'Send an invite to a participant WhatsApp cannot add directly (wwebjs default: true)'
      ),
    comment: z.string().max(1000).optional().describe('Text sent with such an invite'),
    memberAddMode: z
      .boolean()
      .optional()
      .describe('true: every member can add people; false: only the admins'),
    membershipApprovalMode: z
      .boolean()
      .optional()
      .describe('An admin must approve who asks to join'),
    isRestrict: z.boolean().optional().describe('Only the admins edit the info of the group'),
    isAnnounce: z.boolean().optional().describe('Only the admins send messages')
  })
  .describe('The group to create')
export type CreateGroupBody = z.infer<typeof CreateGroupBody>
export class CreateGroupBodyDto extends createZodDto(CreateGroupBody) {}

export const UpdateGroupBody = z
  .strictObject({
    subject: Subject.optional(),
    description: z
      .string()
      .max(MAX_GROUP_DESCRIPTION_LENGTH)
      .optional()
      .describe('An empty text removes the description')
  })
  .refine(body => Object.keys(body).length > 0, {
    message: 'send at least a subject or a description'
  })
export class UpdateGroupBodyDto extends createZodDto(UpdateGroupBody) {}

export const GroupSettingsBody = z
  .strictObject({
    messagesAdminsOnly: z.boolean().optional().describe('true: only the admins send messages'),
    infoAdminsOnly: z.boolean().optional().describe('true: only the admins edit the group info'),
    addMembersAdminsOnly: z.boolean().optional().describe('true: only the admins add people')
  })
  .refine(body => Object.keys(body).length > 0, { message: 'send at least one setting' })
export type GroupSettingsBody = z.infer<typeof GroupSettingsBody>
export class GroupSettingsBodyDto extends createZodDto(GroupSettingsBody) {}

export const GroupParticipantsBody = z
  .strictObject({
    action: z.enum(['add', 'remove', 'promote', 'demote']),
    participants: Participants,
    options: z
      .strictObject({
        sleep: Sleep.optional(),
        autoSendInviteV4: z
          .boolean()
          .optional()
          .describe('Send an invite to a participant WhatsApp cannot add directly'),
        comment: z.string().max(1000).optional().describe('Text sent with such an invite')
      })
      .optional()
      .describe('Only for `add`')
  })
  .refine(body => body.options === undefined || body.action === 'add', {
    path: ['options'],
    message: 'options only apply to the action add'
  })
  .refine(body => fitsTimeout(body.participants.length, body.options?.sleep), {
    path: ['options', 'sleep'],
    message: `participants times the longest pause must not pass ${MAX_PAUSES_MS} ms`
  })
export type GroupParticipantsBody = z.infer<typeof GroupParticipantsBody>
export class GroupParticipantsBodyDto extends createZodDto(GroupParticipantsBody) {}

export const SetGroupPictureBody = z.strictObject({
  source: MediaSource.describe(
    'An image: inline `base64` (the body of a request is limited to 1 MiB), a public `url` (fetched by the gateway), or the `messageId` of a message whose image is used'
  )
})
export class SetGroupPictureBodyDto extends createZodDto(SetGroupPictureBody) {}

export const MembershipRequestsActionBody = z
  .strictObject({
    requesterIds: z
      .union([UserId, z.array(UserId).min(1).max(MAX_PARTICIPANTS_PER_CALL)])
      .optional()
      .describe('Who to answer; without it every pending request is answered'),
    sleep: Sleep.optional()
  })
  .refine(
    body =>
      fitsTimeout(Array.isArray(body.requesterIds) ? body.requesterIds.length : 1, body.sleep),
    {
      path: ['sleep'],
      message: `requesters times the longest pause must not pass ${MAX_PAUSES_MS} ms`
    }
  )

export class MembershipRequestsActionBodyDto extends createZodDto(MembershipRequestsActionBody) {}

export const JoinGroupBody = z.strictObject({ inviteCode: InviteCode })
export class JoinGroupBodyDto extends createZodDto(JoinGroupBody) {}

// ---- Responses ---------------------------------------------------------------------------------

// The message inside the group is the copy without its `meta.id` (see chats.dto.ts)
const Group = z.object({
  ...GroupChatDto.shape,
  lastMessage: z.object(MessageDto.shape).optional()
})

export const GroupResponseDto = createZodDto(Group)
export class GroupListDto extends createZodDto(z.object({ items: z.array(Group) })) {}

export class CreateGroupResultDto extends createZodDto(
  z.object({
    subject: z.string(),
    groupId: z.string().describe('Id of the new group'),
    participants: z
      .record(
        z.string(),
        z.object({
          statusCode: z
            .number()
            .int()
            .optional()
            .describe('200 when added; another code says why not'),
          message: z.string().optional(),
          isGroupCreator: z.boolean().optional(),
          isInviteV4Sent: z.boolean().optional()
        })
      )
      .describe('What WhatsApp answered for each participant, by id')
  })
) {}

export class ParticipantsResultDto extends createZodDto(
  z.object({
    status: z
      .number()
      .int()
      .optional()
      .describe('The status WhatsApp answered (remove, promote, demote)'),
    participants: z
      .record(
        z.string(),
        z.object({
          code: z.number().int().optional().describe('200 when added; another code says why not'),
          message: z.string().optional(),
          isInviteV4Sent: z.boolean().optional()
        })
      )
      .optional()
      .describe('What WhatsApp answered for each participant, by id (add)')
  })
) {}

export class InviteCodeDto extends createZodDto(
  z.object({
    code: z.string(),
    url: z.string().describe('The invite link: https://chat.whatsapp.com/<code>')
  })
) {}

export class MembershipRequestListDto extends createZodDto(
  z.object({ items: z.array(z.object(MembershipRequestDto.shape)) })
) {}

export class MembershipRequestsResultDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        requesterId: z.union([z.string(), z.array(z.string())]).nullable(),
        error: z.number().int().optional().describe('Present when WhatsApp refused this one'),
        message: z.string()
      })
    )
  })
) {}

export class JoinedGroupDto extends createZodDto(
  z.object({ groupId: z.string().describe('Id of the group the account joined') })
) {}

export class InviteInfoDto extends createZodDto(
  z.object({
    info: z
      .record(z.string(), z.unknown())
      .describe('What WhatsApp tells about the group of the invite')
  })
) {}

// The one place that builds the invite link
export const inviteUrl = (code: string): string => `https://chat.whatsapp.com/${code}`
