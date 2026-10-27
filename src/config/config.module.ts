import { Global, Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'

import { type AppConfig, parseEnv } from './env.schema.js'

// Injection token of the typed configuration; AppConfig itself is only a type
export const APP_CONFIG = Symbol('APP_CONFIG')

// ConfigService.get falls back to process.env for a key parseEnv left undefined, so a blank optional
// variable would arrive as "": the parsed object is kept and provided as it is
let parsed: AppConfig | undefined

function validate(raw: Record<string, unknown>): AppConfig {
  parsed = parseEnv(raw)
  return parsed
}

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      // A developer's own .env must not change what the specs see
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      envFilePath: ['.env.local', '.env'],
      validate
    })
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => {
        if (parsed === undefined) throw new Error('The environment was not validated')
        return parsed
      }
    }
  ],
  exports: [APP_CONFIG]
})
export class ConfigModule {}
