import { Command } from "effect-domains/command"
import { ReadModel } from "effect-domains/read-model"
import { RepairBoardList } from "./board.ts"
import { RepairWorkshopUnavailable } from "./domain.ts"


const repairBoard = ReadModel.publish({
  name: "workshop.board",
  unavailable: RepairWorkshopUnavailable,
  page: RepairBoardList,
})

export const RepairWorkshopOperations = Command.bundle(repairBoard)
