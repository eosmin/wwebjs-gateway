import { access, mkdir, rm, writeFile, constants } from 'node:fs/promises'
import { join } from 'node:path'

import { Inject, Injectable } from '@nestjs/common'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'

// Where whatsapp-web.js keeps the logins. A folder that cannot be created or written makes every
// browser start fail on its own and then retry forever, with nothing pointing at the folder, so it is
// checked up front: at boot (the gateway does not start) and on every readiness probe.

// The errno code of a failed file call. Read as a plain property: an error of the fs module is not
// always an `Error` of this realm (it is not under Jest).
const reasonOf = (error: unknown): string => {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}

// Creates the folder if it is missing and proves it takes a file. Throws a message that names the
// variable and the reason (the error code only: a path or a library text is not repeated).
export async function assertDataPathUsable(path: string): Promise<void> {
  const probe = join(path, `.write-probe-${process.pid}`)
  try {
    await mkdir(path, { recursive: true })
    // Removed whatever the write does, so a failed probe leaves no file in the folder of the logins
    await writeFile(probe, '').finally(() => rm(probe, { force: true }))
  } catch (error: unknown) {
    throw new Error(
      `WWEBJS_DATA_PATH is not usable (${reasonOf(error)}): create the folder and make it writable by the gateway user, or point the variable to one that is`,
      { cause: error }
    )
  }
}

// The cheap check of a probe: the folder is there and writable, nothing is created or written
export async function isDataPathWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

// Stops the application from starting when the saved logins cannot be kept, instead of creating
// sessions that then fail in a loop
@Injectable()
export class DataPathGuard {
  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'WWEBJS_DATA_PATH'>) {}

  async onModuleInit(): Promise<void> {
    await assertDataPathUsable(this.config.WWEBJS_DATA_PATH)
  }
}
