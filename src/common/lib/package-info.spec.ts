import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ZodError } from 'zod'

import { readPackageInfo } from './package-info.js'

describe('readPackageInfo', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'package-info-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const manifest = (content: string): void =>
    writeFileSync(join(directory, 'package.json'), content)

  it('reads the versions of the manifest in the given directory', () => {
    manifest(JSON.stringify({ version: '1.2.3', dependencies: { 'whatsapp-web.js': '9.9.9' } }))

    expect(readPackageInfo(directory)).toEqual({ gatewayVersion: '1.2.3', wwebjsVersion: '9.9.9' })
  })

  it('reads the manifest of the project by default', () => {
    const info = readPackageInfo()

    expect(info.wwebjsVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(info.gatewayVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('refuses a manifest without whatsapp-web.js', () => {
    manifest(JSON.stringify({ version: '1.0.0' }))

    expect(() => readPackageInfo(directory)).toThrow(ZodError)
  })

  it('refuses a directory without a manifest', () => {
    expect(() => readPackageInfo(directory)).toThrow(/ENOENT/)
  })

  it('refuses a manifest that is not JSON', () => {
    manifest('{ nope')

    expect(() => readPackageInfo(directory)).toThrow(SyntaxError)
  })
})
