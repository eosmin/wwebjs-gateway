import { processTreeRssBytes } from './process-memory.js'

const TABLE = `
    1     0   1000
  100     1   2000
  101   100   3000
  102   101   4000
  200     1   9000
`

describe('processTreeRssBytes', () => {
  it('adds the process and all its descendants, however deep, and nothing else', async () => {
    const bytes = await processTreeRssBytes(100, () => Promise.resolve(TABLE))

    expect(bytes).toBe((2000 + 3000 + 4000) * 1024)
  })

  it('finds a child listed before its parent', async () => {
    const table = '102 101 4\n101 100 3\n100 1 2\n'

    await expect(processTreeRssBytes(100, () => Promise.resolve(table))).resolves.toBe(9 * 1024)
  })

  it('is undefined when the process is not in the table', async () => {
    await expect(processTreeRssBytes(999, () => Promise.resolve(TABLE))).resolves.toBeUndefined()
  })

  it('is undefined when ps cannot run', async () => {
    await expect(
      processTreeRssBytes(100, () => Promise.reject(new Error('ENOENT')))
    ).resolves.toBeUndefined()
  })

  it('skips lines that are not numbers', async () => {
    const table = 'PID PPID RSS\n100 1 5\n101 100 x\n'

    await expect(processTreeRssBytes(100, () => Promise.resolve(table))).resolves.toBe(5 * 1024)
  })

  it('measures this very process with the real ps', async () => {
    const bytes = await processTreeRssBytes(process.pid)

    expect(bytes).toBeGreaterThan(1024 * 1024)
  })
})
