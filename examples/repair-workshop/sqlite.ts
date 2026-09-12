import { Operation } from "effect-domains/operation"
import { RepairBoardList } from "./board.ts"
import { RepairWorkshopUnavailable } from "./domain.ts"


const repairBoard = Operation.make({
  name: "workshop.board",
  payload: RepairBoardList.payload,
  success: RepairBoardList.success,
  errors: RepairBoardList.errors,
  dependencies: RepairBoardList.dependencies,
  unavailable: RepairWorkshopUnavailable,
  handler: RepairBoardList.handler,
})

export const RepairWorkshopOperations = Operation.bundle(repairBoard)
