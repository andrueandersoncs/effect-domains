import { Effect, Option, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { RepairBoard } from "./board.ts"
import { RepairWorkshopRpcs } from "./contracts.ts"
import { RepairBoardInputSchema, RepairWorkshopUnavailable } from "./domain.ts"

const board = SqlSchema.findAll({
  Request: RepairBoardInputSchema,
  Result: RepairBoard.schema,
  execute: Effect.fn("RepairWorkshop.board")(function* (input) {
    const sql = yield* SqlClient.SqlClient
    const statusColumn = RepairBoard.column(sql, ["job", "status"])

    const status = pipe(Option.fromNullishOr(input.status), Option.match({
      onNone: () => sql`1`,
      onSome: (value) => sql`${statusColumn} = ${value}`,
    }))

    return yield* sql<Readonly<Record<string, unknown>>>`
      ${RepairBoard.select(sql)}
      WHERE ${status}
      ORDER BY ${RepairBoard.column(sql, ["job", "urgent"])} DESC, ${RepairBoard.column(sql, ["job", "id"])} ASC
      LIMIT ${input.limit ?? 50}
    `
  }),
})

const unavailable = () => RepairWorkshopUnavailable.make({})

const queryBoard = Effect.fn("RepairWorkshop.queryBoard")(
  function* (input: typeof RepairBoardInputSchema.Type) {
    return yield* board(input)
  },
  Effect.catchTags({ SqlError: unavailable, SchemaError: unavailable }),
)

export const RepairWorkshopSqlite = RepairWorkshopRpcs.toLayer({
  "workshop.board": queryBoard,
})
