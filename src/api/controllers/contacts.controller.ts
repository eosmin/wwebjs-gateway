import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { ContactsService } from '../../services/contacts.service.js'
import {
  AddressbookParamsDto,
  CommonGroupsDto,
  ContactAboutDto,
  ContactBroadcastDto,
  ContactListDto,
  ContactPictureDto,
  ContactResponseDto,
  DeviceCountDto,
  SaveAddressbookBodyDto,
  SessionContactParamsDto,
  addressbookNumber
} from '../../types/contacts.dto.js'
import type { BroadcastDto } from '../../types/dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import type { AnyContactDto } from '../../whatsapp/whatsapp-client.port.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]

const CONTACT = {
  id: '5215500000001@c.us',
  number: '5215500000001',
  isBusiness: false,
  isEnterprise: false,
  isGroup: false,
  isMe: false,
  isMyContact: true,
  isUser: true,
  isWAContact: true,
  isBlocked: false,
  pushname: 'Cliente',
  sectionHeader: '',
  statusMute: false,
  type: 'in'
}

// The contacts of the account: reading them, block and unblock, and the address book of the linked
// phone. Who a phone number is, without a contact, is `numbers.lookup` and `contacts.lidPhone`.
@Controller('v1/sessions')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get(':sessionId/contacts')
  @ZodResponse({ type: ContactListDto })
  @WaOperation({
    id: 'contacts.list',
    scope: 'read',
    summary: 'List the contacts',
    description:
      'Every contact WhatsApp Web has loaded: the address book and the people the account has talked to. A business account carries its `businessProfile`.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [CONTACT] } },
    wwebjs: ['Client.getContacts']
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<ContactListDto> {
    return { items: await this.contacts.list(sessionId) }
  }

  @Get(':sessionId/contacts/blocked')
  @ZodResponse({ type: ContactListDto })
  @WaOperation({
    id: 'contacts.blocked',
    scope: 'read',
    summary: 'List the blocked contacts',
    description: 'The contacts the account has blocked.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: [{ ...CONTACT, isBlocked: true }] } },
    wwebjs: ['Client.getBlockedContacts']
  })
  async blocked(@Param() { sessionId }: SessionIdParamsDto): Promise<ContactListDto> {
    return { items: await this.contacts.blocked(sessionId) }
  }

  @Get(':sessionId/contacts/:contactId')
  @ZodResponse({ type: ContactResponseDto })
  @WaOperation({
    id: 'contacts.get',
    scope: 'read',
    summary: 'Read a contact',
    description:
      'One contact by its id (`@c.us` or `@lid`). A business account carries its `businessProfile`.',
    errors: ON_SESSION,
    examples: { request: null, response: CONTACT },
    wwebjs: ['Client.getContactById', 'Broadcast.getContact']
  })
  get(@Param() { sessionId, contactId }: SessionContactParamsDto): Promise<AnyContactDto> {
    return this.contacts.get(sessionId, contactId)
  }

  @Get(':sessionId/contacts/:contactId/about')
  @ZodResponse({ type: ContactAboutDto })
  @WaOperation({
    id: 'contacts.about',
    scope: 'read',
    summary: 'Read the status text of a contact',
    description:
      'The "about" text of the contact; `null` when WhatsApp gives none, which is what it does when the account has no permission to read it.',
    errors: ON_SESSION,
    examples: { request: null, response: { about: 'Disponible' } },
    wwebjs: ['Contact.getAbout']
  })
  async about(
    @Param() { sessionId, contactId }: SessionContactParamsDto
  ): Promise<ContactAboutDto> {
    return { about: await this.contacts.about(sessionId, contactId) }
  }

  @Get(':sessionId/contacts/:contactId/picture')
  @ZodResponse({ type: ContactPictureDto })
  @WaOperation({
    id: 'contacts.picture',
    scope: 'read',
    summary: 'Read the profile picture link of a contact',
    description:
      'A link to the profile picture; `null` when WhatsApp refuses it, which is what it does when the privacy settings of the contact do not allow it.',
    errors: ON_SESSION,
    examples: { request: null, response: { url: 'https://pps.whatsapp.net/v/example.jpg' } },
    wwebjs: ['Client.getProfilePicUrl', 'Contact.getProfilePicUrl']
  })
  async picture(
    @Param() { sessionId, contactId }: SessionContactParamsDto
  ): Promise<ContactPictureDto> {
    return { url: await this.contacts.picture(sessionId, contactId) }
  }

  @Get(':sessionId/contacts/:contactId/common-groups')
  @ZodResponse({ type: CommonGroupsDto })
  @WaOperation({
    id: 'contacts.commonGroups',
    scope: 'read',
    summary: 'List the groups shared with a contact',
    description: 'The ids of the groups the account and the contact are both in.',
    errors: ON_SESSION,
    examples: { request: null, response: { items: ['120363000000000001@g.us'] } },
    wwebjs: ['Client.getCommonGroups', 'Contact.getCommonGroups']
  })
  async commonGroups(
    @Param() { sessionId, contactId }: SessionContactParamsDto
  ): Promise<CommonGroupsDto> {
    return { items: await this.contacts.commonGroups(sessionId, contactId) }
  }

  @Get(':sessionId/contacts/:contactId/device-count')
  @ZodResponse({ type: DeviceCountDto })
  @WaOperation({
    id: 'contacts.deviceCount',
    scope: 'read',
    summary: 'Count the devices of a contact',
    description:
      'How many devices WhatsApp lists for the contact. The phone counts: a user with one linked WhatsApp Web session has 2. `0` when WhatsApp lists none.',
    errors: ON_SESSION,
    examples: { request: null, response: { count: 2 } },
    wwebjs: ['Client.getContactDeviceCount']
  })
  async deviceCount(
    @Param() { sessionId, contactId }: SessionContactParamsDto
  ): Promise<DeviceCountDto> {
    return { count: await this.contacts.deviceCount(sessionId, contactId) }
  }

  @Get(':sessionId/contacts/:contactId/broadcast')
  @ZodResponse({ type: ContactBroadcastDto })
  @WaOperation({
    id: 'contacts.broadcast',
    scope: 'read',
    summary: 'Read the broadcast (status) of a contact',
    description:
      'The status updates the contact posted, as the broadcast WhatsApp Web keeps for it. Answers 404 `NOT_FOUND` when it holds none.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: {
        id: '5215500000001@c.us',
        timestamp: 1767225600,
        totalCount: 0,
        unreadCount: 0,
        msgs: []
      }
    },
    wwebjs: ['Contact.getBroadcast']
  })
  broadcast(@Param() { sessionId, contactId }: SessionContactParamsDto): Promise<BroadcastDto> {
    return this.contacts.broadcast(sessionId, contactId)
  }

  @Post(':sessionId/contacts/:contactId/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'contacts.block',
    scope: 'manage',
    summary: 'Block a contact',
    description:
      'Blocks the contact in WhatsApp. Fails with `WHATSAPP_ERROR` when WhatsApp refuses.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: ['Contact.block']
  })
  block(@Param() { sessionId, contactId }: SessionContactParamsDto): Promise<void> {
    return this.contacts.block(sessionId, contactId)
  }

  @Post(':sessionId/contacts/:contactId/unblock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'contacts.unblock',
    scope: 'manage',
    summary: 'Unblock a contact',
    description: 'Lifts the block. Fails with `WHATSAPP_ERROR` when WhatsApp refuses.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: ['Contact.unblock']
  })
  unblock(@Param() { sessionId, contactId }: SessionContactParamsDto): Promise<void> {
    return this.contacts.unblock(sessionId, contactId)
  }

  @Put(':sessionId/contacts/:contactId/addressbook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'contacts.saveAddressbook',
    scope: 'manage',
    summary: 'Save a contact in the address book',
    description:
      'Creates the entry, or edits it when it exists. `:contactId` must be the `@c.us` id of a phone number: the address book is keyed by phone, so a `@lid` is `400`. With `syncToAddressbook: true` the linked phone gets the entry too; without it (the wwebjs default is `false`) the entry stays in WhatsApp Web only.',
    errors: ON_SESSION,
    examples: {
      request: { firstName: 'Cliente', lastName: 'Uno', syncToAddressbook: true },
      response: null
    },
    wwebjs: ['Client.saveOrEditAddressbookContact']
  })
  saveAddressbook(
    @Param() { sessionId, contactId }: AddressbookParamsDto,
    @Body() body: SaveAddressbookBodyDto
  ): Promise<void> {
    return this.contacts.saveAddressbook(sessionId, addressbookNumber(contactId), body)
  }

  @Delete(':sessionId/contacts/:contactId/addressbook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'contacts.deleteAddressbook',
    scope: 'manage',
    summary: 'Delete a contact from the address book',
    description:
      'Removes the entry of the address book. `:contactId` must be the `@c.us` id of a phone number.',
    errors: ON_SESSION,
    examples: { request: null, response: null },
    wwebjs: ['Client.deleteAddressbookContact']
  })
  deleteAddressbook(@Param() { sessionId, contactId }: AddressbookParamsDto): Promise<void> {
    return this.contacts.deleteAddressbook(sessionId, addressbookNumber(contactId))
  }
}
