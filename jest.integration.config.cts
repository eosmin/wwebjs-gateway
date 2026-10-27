const base = require('./jest.config.cts')

// Same transform and module mapping as the unit config; only what differs is restated
module.exports = {
  ...base,
  // Runs the Postgres/Redis suites that the unit config skips
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-real\\.spec\\.ts$'],
  testMatch: ['<rootDir>/src/**/*.integration.spec.ts', '<rootDir>/tests/**/*.integration.spec.ts'],
  maxWorkers: 1,
  // Critical code is held to a higher bar than the global one of the unit config
  coverageThreshold: {
    './src/services/send-queue*': { lines: 90, functions: 90, statements: 90, branches: 90 },
    './src/whatsapp/event-pipeline*': { lines: 90, functions: 90, statements: 90, branches: 90 },
    './src/whatsapp/inbound-order-buffer*': {
      lines: 90,
      functions: 90,
      statements: 90,
      branches: 90
    }
  }
}
