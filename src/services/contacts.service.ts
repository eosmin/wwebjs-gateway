import { Inject, Injectable } from '@nestjs/common'

import { WhatsAppError } from '../common/errors.js'
import type { BroadcastDto } from '../types/dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'
import type { AnyContactDto } from '../whatsapp/whatsapp-client.port.js'

export interface AddressbookEntry {
  firstName: string
  lastName: string
  syncToAddressbook?: boolean
}

// What the contacts routes do: reads of the contacts of the account, block and unblock, and the
// address book of the linked phone; each one a call to the session's client.
@Injectable()
export class ContactsService {
  constructor(@Inject(SessionManager) private readonly sessions: SessionManager) {}

  // ---- Reads -----------------------------------------------------------------------------------

  list(sessionId: string): Promise<AnyContactDto[]> {
    return this.sessions.requireReady(sessionId).getContacts()
  }

  blocked(sessionId: string): Promise<AnyContactDto[]> {
    return this.sessions.requireReady(sessionId).getBlockedContacts()
  }

  get(sessionId: string, contactId: string): Promise<AnyContactDto> {
    return this.sessions.requireReady(sessionId).getContactById(contactId)
  }

  about(sessionId: string, contactId: string): Promise<string | null> {
    return this.sessions.requireReady(sessionId).getContactAbout(contactId)
  }

  picture(sessionId: string, contactId: string): Promise<string | null> {
    return this.sessions.requireReady(sessionId).getProfilePicUrl(contactId)
  }

  commonGroups(sessionId: string, contactId: string): Promise<string[]> {
    return this.sessions.requireReady(sessionId).getCommonGroups(contactId)
  }

  deviceCount(sessionId: string, contactId: string): Promise<number> {
    return this.sessions.requireReady(sessionId).getContactDeviceCount(contactId)
  }

  broadcast(sessionId: string, contactId: string): Promise<BroadcastDto> {
    return this.sessions.requireReady(sessionId).getContactBroadcast(contactId)
  }

  // ---- Actions ---------------------------------------------------------------------------------

  // WhatsApp Web answers false when it did not do it
  async block(sessionId: string, contactId: string): Promise<void> {
    if (!(await this.sessions.requireReady(sessionId).blockContact(contactId))) {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not block the contact')
    }
  }

  async unblock(sessionId: string, contactId: string): Promise<void> {
    if (!(await this.sessions.requireReady(sessionId).unblockContact(contactId))) {
      throw new WhatsAppError('WHATSAPP_ERROR', 'WhatsApp did not unblock the contact')
    }
  }

  // `phoneNumber` is the digits of the contact; the same call creates or edits the entry
  saveAddressbook(sessionId: string, phoneNumber: string, entry: AddressbookEntry): Promise<void> {
    return this.sessions
      .requireReady(sessionId)
      .saveOrEditAddressbookContact(
        phoneNumber,
        entry.firstName,
        entry.lastName,
        entry.syncToAddressbook
      )
  }

  deleteAddressbook(sessionId: string, phoneNumber: string): Promise<void> {
    return this.sessions.requireReady(sessionId).deleteAddressbookContact(phoneNumber)
  }
}
