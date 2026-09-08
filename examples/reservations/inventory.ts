import { Context, Schema } from "effect"
import type { CommandService } from "effect-domains/application"
import type { ReservationCommands } from "./contracts.ts"

export class InventoryUnavailable extends Schema.TaggedError<InventoryUnavailable>()(
  "InventoryUnavailable",
  {},
) {}

export class Inventory extends Context.Service<
  Inventory,
  CommandService<typeof ReservationCommands>
>()("examples/reservations/Inventory") {}
