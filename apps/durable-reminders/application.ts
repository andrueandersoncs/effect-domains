import { Application } from "effect-domains/application"
import { ReminderEntityCommands } from "./reminder-entity.ts"
import { ReminderReceiptResource } from "./resources.ts"

export const DurableRemindersApplication = Application.make({
  name: "durable-reminders",
  resources: [ReminderReceiptResource],
  commands: [ReminderEntityCommands],
})
