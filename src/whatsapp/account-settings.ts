// The flags of the WhatsApp Web account that live in `Session.settings`, and the client call that
// applies each one. The session manager applies them every time a session is ready; the settings
// route applies them at once and stores them, so both read this one table.
export const ACCOUNT_SETTING_CALLS = [
  ['autoDownloadAudio', 'setAutoDownloadAudio'],
  ['autoDownloadDocuments', 'setAutoDownloadDocuments'],
  ['autoDownloadPhotos', 'setAutoDownloadPhotos'],
  ['autoDownloadVideos', 'setAutoDownloadVideos'],
  ['backgroundSync', 'setBackgroundSync']
] as const

export type AccountSettingKey = (typeof ACCOUNT_SETTING_CALLS)[number][0]
