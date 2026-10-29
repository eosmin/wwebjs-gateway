import { listWwebjsSymbols, readWwebjsSymbols } from './wwebjs-symbols.js'

describe('listWwebjsSymbols', () => {
  it('lists the members of classes and interfaces as Owner.member', () => {
    const source = `
      declare namespace WAWebJS {
        export class Client {
          constructor(options: object)
          info: string
          getState(): Promise<string>
        }
        export interface Chat { id: string; archive(): Promise<void> }
        export type Ignored = { a: string }
      }
    `
    expect(listWwebjsSymbols(source)).toEqual([
      'Chat.archive',
      'Chat.id',
      'Client.getState',
      'Client.info'
    ])
  })

  it('lists events by their wire name, once', () => {
    const source = `
      declare namespace WAWebJS {
        export enum Events { CALL = 'call', INCOMING_CALL = 'call', READY = 'ready' }
        export enum ChatTypes { SOLO = 'solo' }
      }
    `
    expect(listWwebjsSymbols(source)).toEqual(['Events.call', 'Events.ready'])
  })

  it('lists a quoted member without its quotes, and an overload once', () => {
    const source = `
      declare namespace WAWebJS {
        export class Client extends Base {
          'quoted-name': string
          readonly flag: boolean
          send(a: string): void
          send(a: number): void
        }
      }
    `
    expect(listWwebjsSymbols(source)).toEqual(['Client.flag', 'Client.quoted-name', 'Client.send'])
  })

  it('reads the installed library', () => {
    const symbols = readWwebjsSymbols()
    expect(symbols.length).toBeGreaterThan(400)
    expect(symbols).toEqual(
      expect.arrayContaining([
        'Client.sendMessage',
        'Chat.sendStateTyping',
        'Events.qr',
        'Client.pupPage',
        'ClientOptions.authStrategy'
      ])
    )
  })
})
