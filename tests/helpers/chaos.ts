import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { env } from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// The chaos suites stop and start real servers, so they cannot use the Postgres and Redis of the shell
// or of CI (other suites share those). Each suite starts its own container on a free loopback port,
// named with this prefix and labelled so that a run that died can be swept.
const NAME_PREFIX = 'wwebjs-gw-chaos'
const LABEL = 'wwebjs-gw.chaos=1'

const POSTGRES = { user: 'gateway', password: 'chaos_password', database: 'gateway_chaos' }

// The images of the development stack, so a chaos suite tests the version the gateway ships with
function composeImage(service: 'postgres' | 'redis'): string {
  const compose = readFileSync('docker-compose.yml', 'utf8')
  const found = new RegExp(`^ {2}${service}:\\n {4}image: (\\S+)`, 'm').exec(compose)?.[1]
  if (found === undefined) throw new Error(`docker-compose.yml has no image for ${service}`)
  return found
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 })
  return stdout.trim()
}

// A port nobody listens on right now. It is released before Docker publishes it, so another process
// could take it in between; the loopback of a test machine makes that unlikely.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'))
        else resolve(address.port)
      })
    })
  })
}

async function holds(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await condition()
  } catch {
    return false
  }
}

// Polls `condition` until it holds. The chaos suites wait for a real server to answer, so there is no
// fixed sleep and no fake clock: the deadline only bounds a server that never comes back.
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 30_000, everyMs = 100, what = 'the condition' } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await holds(condition)) return
    if (Date.now() > deadline) throw new Error(`${what} did not hold within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, everyMs))
  }
}

// One dependency of the gateway in its own container, which a test can stop, start and kill
export class ChaosContainer {
  constructor(
    readonly name: string,
    readonly url: string,
    private readonly isReady: () => Promise<boolean>
  ) {}

  // A graceful stop (SIGTERM): the server flushes what it holds before it exits
  async stop(): Promise<void> {
    await docker('stop', '--time', '10', this.name)
  }

  // SIGKILL: the server gets no chance to flush
  async kill(): Promise<void> {
    await docker('kill', this.name)
  }

  // Starts the same container again: it keeps its filesystem, and so its data, and its port
  async start(): Promise<void> {
    await docker('start', this.name)
    await this.waitReady()
  }

  // The process is frozen with its sockets open: it answers nothing, and a command already written to
  // it is neither refused nor lost. This is a command in flight, which a stop cannot make deterministic.
  async pause(): Promise<void> {
    await docker('pause', this.name)
  }

  async unpause(): Promise<void> {
    await docker('unpause', this.name)
  }

  // For a teardown or a guard after a test that failed half way: running again, whatever it was
  async ensureRunning(): Promise<void> {
    await docker('unpause', this.name).catch(() => undefined)
    await docker('start', this.name)
    await this.waitReady()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async waitReady(): Promise<void> {
    await eventually(this.isReady, { what: `${this.name} to answer` })
  }

  async remove(): Promise<void> {
    await docker('rm', '--force', '--volumes', this.name).catch(() => undefined)
  }
}

// Every container this process started, so a spec removes them all even when one start failed
const started: ChaosContainer[] = []

export async function removeChaosContainers(): Promise<void> {
  await Promise.all(started.splice(0).map(container => container.remove()))
}

// `docker run` and the wait for the server, removing the container when either fails
async function launch(
  name: string,
  runArgs: string[],
  url: string,
  isReady: () => Promise<boolean>,
  prepare: () => Promise<void> = () => Promise.resolve()
): Promise<ChaosContainer> {
  const container = new ChaosContainer(name, url, isReady)
  started.push(container)
  try {
    await docker('run', '--detach', '--name', name, '--label', LABEL, ...runArgs)
    await container.waitReady()
    await prepare()
  } catch (error) {
    await container.remove()
    throw error
  }
  return container
}

function containerName(kind: string): string {
  return `${NAME_PREFIX}-${kind}-${randomBytes(4).toString('hex')}`
}

// Redis as the development stack runs it: AOF on, so the queues survive a restart
export async function startRedis(): Promise<ChaosContainer> {
  const name = containerName('redis')
  const port = await freePort()
  return launch(
    name,
    [
      '--publish',
      `127.0.0.1:${port}:6379`,
      composeImage('redis'),
      'redis-server',
      '--appendonly',
      'yes',
      '--maxmemory-policy',
      'noeviction'
    ],
    `redis://127.0.0.1:${port}`,
    async () => (await docker('exec', name, 'redis-cli', 'ping')) === 'PONG'
  )
}

// Postgres with every migration of the repository applied
export async function startPostgres(): Promise<ChaosContainer> {
  const name = containerName('postgres')
  const port = await freePort()
  const url = `postgresql://${POSTGRES.user}:${POSTGRES.password}@127.0.0.1:${port}/${POSTGRES.database}`
  return launch(
    name,
    [
      '--env',
      `POSTGRES_USER=${POSTGRES.user}`,
      '--env',
      `POSTGRES_PASSWORD=${POSTGRES.password}`,
      '--env',
      `POSTGRES_DB=${POSTGRES.database}`,
      '--publish',
      `127.0.0.1:${port}:5432`,
      composeImage('postgres')
    ],
    url,
    async () => {
      await docker('exec', name, 'pg_isready', '-U', POSTGRES.user, '-d', POSTGRES.database)
      // The image starts a temporary server to run its init, which answers pg_isready and then goes
      // away: a real query over the published port proves the final server is the one answering
      await docker(
        'exec',
        name,
        'psql',
        '-h',
        '127.0.0.1',
        '-U',
        POSTGRES.user,
        '-d',
        POSTGRES.database,
        '-tAc',
        'SELECT 1'
      )
      return true
    },
    async () => {
      await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: { ...env, DATABASE_URL: url },
        timeout: 120_000
      })
    }
  )
}
