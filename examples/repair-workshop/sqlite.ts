import { Effect, Option, Schema, pipe } from "effect"

import { SqlClient, SqlSchema } from "effect/unstable/sql"

import { Operation } from "effect-domains/operation"

import { RepairBoard, RepairBoardRowSchema } from "./board.ts"

import {
  RepairBoardInputSchema,
  RepairWorkshopUnavailable,
} from "./domain.ts"

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

const repairBoardSuccessSchema = Schema.Array(RepairBoardRowSchema)

const repairBoard = Operation.make({
  name: "workshop.board",
  payload: RepairBoardInputSchema,
  success: repairBoardSuccessSchema,
  error: RepairWorkshopUnavailable,
  views: [RepairBoard],
  unavailable: RepairWorkshopUnavailable,
  handler: board,
})

export const RepairWorkshopOperations = Operation.bundle(repairBoard)
