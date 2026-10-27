module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/env.ts'],
  transform: { '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Sources import siblings with the ESM `.js` suffix; Jest resolves the `.ts` file behind it
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Globs instead of `roots`: a directory that does not exist yet (tests/) is simply empty, so a spec
  // placed there later is found without touching this file
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/tests/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts'
  ],
  // Needs Postgres/Redis (integration job) or a real WhatsApp account (opt-in)
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.integration\\.spec\\.ts$',
    '\\.e2e-real\\.spec\\.ts$'
  ],
  coverageDirectory: 'coverage',
  // Count every source file, not only the ones a test happens to load: a file nobody tests must
  // lower the number, or a threshold means nothing
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!**/*.spec.{ts,tsx}',
    '!**/*.d.ts',
    '!**/index.ts',
    '!src/generated/**',
    '!src/main.ts', // bootstrap: exercised by the boot smoke test in CI
    '!src/whatsapp/wwebjs-adapter.ts' // needs a real WhatsApp account: covered by the opt-in E2E_REAL suite
  ],
  coverageThreshold: { global: { lines: 80, functions: 80, statements: 80, branches: 75 } }
}
