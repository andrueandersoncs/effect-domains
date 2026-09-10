import { type Brand, Schema } from "effect"

export type StructSchema = Schema.Struct<Schema.Struct.Fields>

export const DomainIdentifier = "@effect-domains/domain/identifier"

export const identifier = <S extends Schema.Top>(
  schema: S,
) =>
  schema.annotate({
    [DomainIdentifier]: true,
  }) as S & Brand.Brand<typeof DomainIdentifier>
