import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SqliteView } from "effect-domains/sqlite-view"
import { RepairBoard, RepairBoardRowSchema } from "./board.ts"
import { RepairBoardInputSchema, RepairWorkshopUnavailable } from "./domain.ts"

const RepairBoardRowsSchema = Schema.Array(RepairBoardRowSchema)

const board = Rpc.make("workshop.board", {
  payload: RepairBoardInputSchema,
  success: RepairBoardRowsSchema,
  error: RepairWorkshopUnavailable,
}).annotate(SqliteView.annotation, [RepairBoard])

export const RepairWorkshopRpcs = RpcGroup.make(board)
