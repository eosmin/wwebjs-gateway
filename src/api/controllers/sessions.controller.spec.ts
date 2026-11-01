import { collectOperations } from '../../parity/operation-links.js'
import { SessionsModule } from '../sessions.module.js'

// A wrong scope on the pairing code routes would let a key link an account it must not: the table
// pins the scope and the wwebjs symbols of the operations that reach the client
const EXPECTED: Record<string, { scope: string; wwebjs: string[] }> = {
  'sessions.requestPairingCode': { scope: 'manage', wwebjs: ['Client.requestPairingCode'] },
  'sessions.cancelPairingCode': { scope: 'manage', wwebjs: ['Client.cancelPairingCode'] },
  'sessions.info': {
    scope: 'read',
    wwebjs: [
      'Client.info',
      'ClientInfo.getBatteryStatus',
      'ClientInfo.wid',
      'ClientInfo.me',
      'ClientInfo.platform',
      'ClientInfo.pushname',
      'ClientInfo.phone',
      'ClientInfoPhone.wa_version',
      'ClientInfoPhone.os_version',
      'ClientInfoPhone.device_manufacturer',
      'ClientInfoPhone.device_model',
      'ClientInfoPhone.os_build_number',
      'BatteryInfo.battery',
      'BatteryInfo.plugged'
    ]
  }
}

describe('SessionsController operations', () => {
  it('declares the pairing code and info operations with their scope and wwebjs symbols', async () => {
    const operations = await collectOperations(SessionsModule)
    const found = Object.fromEntries(
      operations
        .filter(operation => operation.id in EXPECTED)
        .map(op => [op.id, { scope: op.scope, wwebjs: op.wwebjs }])
    )

    expect(found).toEqual(EXPECTED)
  })
})
