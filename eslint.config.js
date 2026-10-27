import path from 'node:path'

import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'

const processEnvBan = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: 'Read configuration through the validated AppConfig (src/config)'
}

// Numbers are not statuses: name them with Nest's HttpStatus
const STATUS_ARGUMENT = 'Literal[raw=/^[1-5][0-9]{2}$/]'
const httpStatusBans = [
  {
    selector: `NewExpression[callee.name=/^(HttpException|AppError)$/] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: HttpStatus.NOT_FOUND, not 404'
  },
  {
    selector: `CallExpression[callee.name='HttpCode'] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: @HttpCode(HttpStatus.CREATED), not 201'
  },
  {
    selector: `CallExpression[callee.property.name=/^(status|code)$/] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: reply.status(HttpStatus.NOT_FOUND), not 404'
  }
]

const deepRelativeImport = {
  group: ['../../../*'],
  message: 'Use a path alias or restructure instead of deep relative imports'
}
// Boundaries of the architecture (SOLID: everything depends on the port / the repositories)
const restrictedPaths = [
  {
    name: 'whatsapp-web.js',
    message: 'Only src/whatsapp/wwebjs-adapter.ts may import whatsapp-web.js'
  },
  {
    name: '@prisma/client',
    message: 'Only src/database/** may use the Prisma client (use a repository)'
  },
  { name: '@nestjs/platform-express', message: 'This project runs on @nestjs/platform-fastify' },
  { name: 'prom-client', message: 'Use @prometheus-io/client' },
  { name: 'redis', message: 'Use ioredis' }
]

// The generator writes the Prisma client into src/generated/prisma, so the code imports it by a
// relative path and never as '@prisma/client': the package name alone would not catch it
const prismaClientImport = {
  group: ['**/generated/prisma', '**/generated/prisma/**'],
  message: 'Only src/database/** may use the Prisma client (use a repository)'
}

// Every block restates the whole option object, so the shared parts live in one place
const restrictImports = exceptName => [
  'error',
  {
    paths: restrictedPaths.filter(p => p.name !== exceptName),
    patterns:
      exceptName === '@prisma/client'
        ? [deepRelativeImport]
        : [deepRelativeImport, prismaClientImport]
  }
]

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    settings: {
      'import-x/resolver': {
        typescript: { project: path.join(import.meta.dirname, 'tsconfig.json') }
      }
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true }
      ],

      'no-console': 'error',
      'no-restricted-imports': restrictImports(),
      'no-restricted-syntax': ['error', processEnvBan, ...httpStatusBans],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' }
        }
      ]
    }
  },

  // The adapter is the only file that may import the library
  {
    files: ['src/whatsapp/wwebjs-adapter.ts'],
    rules: {
      'no-restricted-imports': restrictImports('whatsapp-web.js')
    }
  },
  // The database layer is the only code that may use the Prisma client
  {
    files: ['src/database/**/*.ts', 'prisma.config.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports('@prisma/client')
    }
  },
  // The single files allowed to read process.env
  {
    files: [
      'src/config/**/*.ts',
      'prisma.config.ts',
      'scripts/**/*.ts',
      'tests/helpers/env.ts',
      'jest*.cts'
    ],
    rules: { 'no-restricted-syntax': ['error', ...httpStatusBans] }
  },
  // Scripts print; everything else uses Pino
  { files: ['scripts/**/*.ts'], rules: { 'no-console': 'off' } },
  // Specs say the status number on purpose: they pin what the code answers
  {
    files: ['**/*.spec.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', processEnvBan] }
  },
  // The env helper of the tests sets process.env, and specs state statuses on purpose: no bans at all
  // (it must come after the block above, which would otherwise ban process.env again)
  { files: ['tests/helpers/env.ts'], rules: { 'no-restricted-syntax': 'off' } },
  // Plain JavaScript files (eslint.config.js itself) are outside tsconfig: no type information
  // The documented default-import style of the config packages trips two import-x heuristics
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'import-x/no-named-as-default': 'off', 'import-x/no-named-as-default-member': 'off' }
  },
  // Plain CommonJS configs (every .cts file is a tool config that Node loads as is): no type information
  {
    files: ['**/*.cjs', '**/*.cts'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs'
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  { ignores: ['**/dist/**', '**/generated/**', '**/coverage/**', 'docs/**'] }
])
