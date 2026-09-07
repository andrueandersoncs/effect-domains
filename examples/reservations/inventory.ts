import { Context, Schema } from "effect"
import type { CommandService } from "../../src/application.ts"
import type { ReservationCommands } from "./contracts.ts"

export class InventoryUnavailable extends Schema.TaggedError<InventoryUnavailable>()(
  "InventoryUnavailable",
  {},
) {}

export class Inventory extends Context.Service<
  Inventory,
  CommandService<typeof ReservationCommands>
>()("examples/reservations/Inventory") {}
