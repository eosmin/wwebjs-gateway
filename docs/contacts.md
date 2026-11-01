# Contacts

The routes under `/v1/sessions/:sessionId/contacts` (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). A contact id is a user id, `5215500000001@c.us` or `100000000000001@lid`; a group or channel id is `400 VALIDATION_ERROR` (those are [chats](chats.md)). Who a phone number is, before it is a contact, is in [lookup](lookup.md) (`numbers.lookup`, `contacts.lidPhone`).

| Operation                    | Route                                    | Scope    | Answer                                  |
| ---------------------------- | ---------------------------------------- | -------- | --------------------------------------- |
| `contacts.list`              | `GET …/contacts`                         | `read`   | `{ items }` of contacts                 |
| `contacts.blocked`           | `GET …/contacts/blocked`                 | `read`   | `{ items }` of contacts                 |
| `contacts.get`               | `GET …/contacts/:contactId`              | `read`   | the contact                             |
| `contacts.about`             | `GET …/contacts/:contactId/about`        | `read`   | `{ about }`                             |
| `contacts.picture`           | `GET …/contacts/:contactId/picture`      | `read`   | `{ url }`                               |
| `contacts.commonGroups`      | `GET …/contacts/:contactId/common-groups` | `read`  | `{ items }` of group ids                |
| `contacts.deviceCount`       | `GET …/contacts/:contactId/device-count` | `read`   | `{ count }`                             |
| `contacts.broadcast`         | `GET …/contacts/:contactId/broadcast`    | `read`   | the broadcast (status) of the contact   |
| `contacts.block`             | `POST …/contacts/:contactId/block`       | `manage` | `204`                                   |
| `contacts.unblock`           | `POST …/contacts/:contactId/unblock`     | `manage` | `204`                                   |
| `contacts.saveAddressbook`   | `PUT …/contacts/:contactId/addressbook`  | `manage` | `204`                                   |
| `contacts.deleteAddressbook` | `DELETE …/contacts/:contactId/addressbook` | `manage` | `204`                                 |

## Reads

- **`contacts.list`, `contacts.blocked` and `contacts.get`** answer the contact as WhatsApp Web has it. A business account (`isBusiness`) also carries `businessProfile` (description, categories, hours, address, website).
- **`contacts.about`** answers `null` when WhatsApp gives no text, which is what it does when the account has no permission to read it. **`contacts.picture`** answers `null` when WhatsApp refuses the picture (the privacy settings of the contact do not allow it).
- **`contacts.deviceCount`** is the number of devices WhatsApp lists for the contact, the phone included (a user with one linked WhatsApp Web session has 2); `0` when it lists none.
- **`contacts.commonGroups`** lists the ids of the groups the account and the contact share; read a group with the groups routes (step 6.2).
- **`contacts.broadcast`** is the status updates the contact posted, as WhatsApp Web keeps them (`404 NOT_FOUND` when it holds none; see [broadcasts](broadcasts.md)).

## Block and unblock

`contacts.block` and `contacts.unblock` answer `204` when WhatsApp did it and `502 WHATSAPP_ERROR` when it answered that it did not. Both need `manage`.

## Address book

`PUT …/contacts/:contactId/addressbook` with `{ firstName, lastName, syncToAddressbook? }` creates the entry or edits it; `DELETE` removes it. The address book is keyed by phone number, so `:contactId` must be the `@c.us` id of a number of 7 to 15 digits: a `@lid` is `400` (ask `contacts.lidPhone` for its `@c.us` first). `lastName` may be empty, `firstName` may not. Without `syncToAddressbook` the wwebjs default applies (`false`: the entry stays in WhatsApp Web); `true` also saves it in the address book of the linked phone.

## What the other wwebjs symbols map to

`Contact.getChat` is `chats.get` (a contact's chat has the contact's id), and `Contact.getCountryCode` / `Contact.getFormattedNumber` are the country code and format of `numbers.lookup`. `Contact.getAbout`, `getProfilePicUrl`, `getCommonGroups`, `getBroadcast`, `block` and `unblock` are the routes above. The fields of `Contact` and `BusinessContact` are the fields of the DTOs.
