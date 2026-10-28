import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

const manifestSchema = z.object({
  version: z.string(),
  dependencies: z.object({ 'whatsapp-web.js': z.string() })
})

export interface PackageInfo {
  gatewayVersion: string
  wwebjsVersion: string
}

// The working directory is the project root, also in the image (WORKDIR /app next to package.json).
// whatsapp-web.js is pinned to an exact version, so the manifest says what is installed.
export function readPackageInfo(directory: string = process.cwd()): PackageInfo {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  )
  return {
    gatewayVersion: manifest.version,
    wwebjsVersion: manifest.dependencies['whatsapp-web.js']
  }
}
