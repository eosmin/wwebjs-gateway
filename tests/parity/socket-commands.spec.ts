import type { WaOperationMeta } from '../../src/api/wa-operation.schema.js'
import { AppModule } from '../../src/app.module.js'
import { collectOperations } from '../../src/parity/operation-links.js'
import { REST_ONLY_OPERATIONS } from '../../src/parity/overrides.js'

let operations: WaOperationMeta[] = []

beforeAll(async () => {
  operations = await collectOperations(AppModule)
})

describe('socket commands', () => {
  it('gives every operation a command or a reason to stay on REST', () => {
    const undecided = operations
      .filter(({ id, socket }) => socket === undefined && !(id in REST_ONLY_OPERATIONS))
      .map(({ id }) => id)
    expect(undecided).toEqual([])
  })

  it('does not list a REST-only operation that has a command or does not exist', () => {
    const byId = new Map(operations.map(operation => [operation.id, operation]))
    const wrong = Object.keys(REST_ONLY_OPERATIONS).filter(id => byId.get(id)?.socket !== undefined)
    const unknown = Object.keys(REST_ONLY_OPERATIONS).filter(id => !byId.has(id))
    expect({ wrong, unknown }).toEqual({ wrong: [], unknown: [] })
  })

  it('states why each operation stays on REST', () => {
    const bare = Object.entries(REST_ONLY_OPERATIONS)
      .filter(([, reason]) => !/^[a-z]+: \S.{8,}/.test(reason))
      .map(([id]) => id)
    expect(bare).toEqual([])
  })

  it('names every command once, as an object and its action', () => {
    const commands = operations.flatMap(({ socket }) => (socket ? [socket.command] : []))
    expect(commands.length).toBeGreaterThan(100)
    expect(new Set(commands).size).toBe(commands.length)
    expect(commands.filter(command => !/^[a-z]+\.[a-zA-Z]+$/.test(command))).toEqual([])
  })

  // A key that may only send must not be able to run an admin or a webhooks operation over a socket
  it('keeps the operations of the admin and webhooks scopes on REST', () => {
    const exposed = operations
      .filter(({ scope, socket }) => (scope === 'admin' || scope === 'webhooks') && socket)
      .map(({ id }) => id)
    expect(exposed).toEqual([])
  })
})
