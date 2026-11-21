// Jest prints this when a worker still had a timer, socket or connection open after its suites ended
// and had to be killed. It is not a failure to Jest, so the wrapper turns it into one.
const LEAK_WARNING = 'A worker process has failed to exit gracefully'

export function hasWorkerLeak(output: string): boolean {
  return output.includes(LEAK_WARNING)
}
