import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { BillingApplication } from "./application.ts"
import { BillingMigrations } from "./migrations.ts"


const services = ExampleIdentity.layer("orders-invoices")

const program = ApplicationBun.run(BillingApplication, {
  database: { migrations: BillingMigrations },
  services,
  ui: {
    presentation: {
      title: "Orders and invoices",
      description: "Create orders, add priced lines, issue invoices, and record payments.",
      operations: {
        "billing.getOrder": {
          label: "Get order summary",
          description: "Use the generated UUID shown in the Orders list, not the business order number.",
        },
      },
    },
  },
})

pipe(program, ApplicationBun.runMain)
