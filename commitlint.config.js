export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes its own titles and body lines, which can exceed the length rules
  ignores: [message => message.includes('Signed-off-by: dependabot[bot]')],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert', 'build']
    ],
    'scope-enum': [
      1,
      'always',
      [
        'api',
        'sessions',
        'messages',
        'chats',
        'contacts',
        'groups',
        'channels',
        'labels',
        'calls',
        'webhooks',
        'inbound',
        'realtime',
        'queue',
        'ordering',
        'origin',
        'whatsapp',
        'watchdog',
        'auth',
        'config',
        'db',
        'database',
        'infra',
        'metrics',
        'logger',
        'parity',
        'docs',
        'e2e',
        'docker',
        'ci',
        'tooling',
        'deps'
      ]
    ],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [1, 'always', 100]
  }
}
