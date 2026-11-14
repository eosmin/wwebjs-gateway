import { createZodDto } from 'nestjs-zod'
import type { z } from 'zod'

// `createZodDto(schema)` returns a class named AugmentedZodDto, and the OpenAPI document names a
// schema after its class: two response DTOs made without `extends` shared one component, so an
// operation was documented with the schema of another (a contact as a chat). A DTO that cannot
// `extends` its schema (a union is not a class base) gets its name here.
export function namedZodDto<S extends z.ZodType>(
  name: string,
  schema: S
): ReturnType<typeof createZodDto<S>> {
  const dto = createZodDto(schema)
  Object.defineProperty(dto, 'name', { value: name })
  return dto
}
