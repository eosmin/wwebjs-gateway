import { hasWorkerLeak } from './jest-leak.js'

describe('hasWorkerLeak', () => {
  it('finds the warning Jest prints when it force exits a worker', () => {
    const output =
      'Tests: 3 passed\nA worker process has failed to exit gracefully and has been force exited.'

    expect(hasWorkerLeak(output)).toBe(true)
  })

  it('is false for a clean run', () => {
    expect(hasWorkerLeak('Test Suites: 2 passed, 2 total\nTests: 9 passed, 9 total')).toBe(false)
  })
})
