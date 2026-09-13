import { Operation } from "effect-domains/operation"
import { SqliteView } from "effect-domains/sqlite-view"
import { RepairBoardList } from "./board.ts"
import { RepairWorkshopUnavailable } from "./domain.ts"


const repairBoard = SqliteView.listOperation({
  name: "workshop.board",
  unavailable: RepairWorkshopUnavailable,
  list: RepairBoardList,
})

export const RepairWorkshopOperations = Operation.bundle(repairBoard)
