# Labels

The routes for the labels of a WhatsApp **Business** account (TDD §6.11): `/v1/sessions/:sessionId/labels` and the labels of one chat under `…/chats/:chatId/labels`. Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). WhatsApp Web has labels on Business accounts only: a personal account lists none, so a non-empty `labelIds` is `400` (no such label) and an empty one is refused by the page (`502 WHATSAPP_ERROR`). The library cannot create, rename, recolor or delete a label, only read them and put them on chats.

| Operation           | Route                           | Scope    | Answer                      |
| ------------------- | ------------------------------- | -------- | --------------------------- |
| `labels.list`       | `GET …/labels`                  | `read`   | `{ items }` of labels       |
| `labels.get`        | `GET …/labels/:labelId`         | `read`   | the label                   |
| `labels.chats`      | `GET …/labels/:labelId/chats`   | `read`   | `{ items }` of chats        |
| `labels.assign`     | `POST …/labels/assign`          | `manage` | `204`                       |
| `labels.ofChat`     | `GET …/chats/:chatId/labels`    | `read`   | `{ items }` of labels       |
| `labels.setForChat` | `PUT …/chats/:chatId/labels`    | `manage` | `204`                       |

A label is `{ id, name, hexColor }`. `:labelId` is the `id` that `labels.list` gives (a short text such as `"1"`).

## Reads

- **`labels.get` and `labels.chats`** answer `404 NOT_FOUND` for a label the account does not have. WhatsApp Web fails on an unknown label with an error that cannot be told from a real one, so the gateway checks the list first (one extra page call). `labels.chats` answers each chat as `chats.get` does (private chat, group or channel).
- **`labels.ofChat`** answers `404 CHAT_NOT_FOUND` for a chat the session lacks, as every route on one chat does.

## Set the labels

`labels.assign` takes `{ labelIds, chatIds }` and `labels.setForChat` takes `{ labelIds }`. Both **set** the labels, they do not add: every chat ends with exactly the labels listed, and any other label it had is removed. An empty `labelIds` clears the chats. To add one label without losing the others, read the labels first (`labels.ofChat`) and send the whole set.

- Up to 50 labels and 100 chats per call, without repeats; `chatIds` needs at least one.
- WhatsApp Web ignores an id it does not know, so a mistake would "work" and change nothing. The gateway checks first: an unknown label is `400 VALIDATION_ERROR` naming it, an unknown chat is `404 CHAT_NOT_FOUND`, and in both cases nothing changes. The check costs one page call per chat.
- The change is applied to all the chats in one WhatsApp Web action; a failure of the page after the checks is `502 WHATSAPP_ERROR` and the labels may be partly applied: read them again.

## What the other wwebjs symbols map to

`Label.getChats` is `labels.chats`, `Chat.getLabels` is `labels.ofChat` and `Chat.changeLabels` is `labels.setForChat`. The fields of `Label` are the fields of the label above. `Contact.labels` is a field of the contact DTOs.
