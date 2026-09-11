import { expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { identifier } from "effect-domains/domain"
import { Table } from "effect-domains/table"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { NestedRow } from "../examples/orders-invoices/projection.ts"
import { prepareTables } from "./prepare-tables.ts"

const EventSchema = Schema.Struct({
  id: identifier(Schema.String),
  active: Schema.Boolean,
  occurredAt: Schema.DateTimeUtc,
  note: Schema.NullOr(Schema.String),
})

const Events = Table.make({ name: "projection_events", schema: EventSchema })
const projection = NestedRow.make({ table: Events, fields: ["id", "active", "occurredAt", "note"] })
const ProjectionRowsSchema = Schema.Array(Schema.Struct({ body: projection.json }))
const database = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

it.effect("nested SQL objects use field names as keys and decode physical booleans, timestamps, and nulls", () => pipe(
  Effect.gen(function* () {
    yield* prepareTables([Events])
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO projection_events (id, active, occurredAt, note)
      VALUES ('event-a', 1, '2026-09-11T12:00:00.000Z', NULL)`

    const rows = yield* sql<{ body: string }>`SELECT ${projection.object(sql, "e")} AS body FROM projection_events e`
    const values = yield* Schema.decodeUnknownEffect(ProjectionRowsSchema)(rows)
    const first = yield* pipe(values, Array.head, Effect.fromOption)
    expect(first.body).toMatchObject({ id: "event-a", active: true, note: null })
    const occurredAt = DateTime.formatIso(first.body.occurredAt)
    expect(occurredAt).toBe("2026-09-11T12:00:00.000Z")
  }),
  Effect.provide(database),
))
