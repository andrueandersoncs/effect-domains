import { Effect, pipe } from "effect"
import * as ApplicationBun from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ElectionsApplication } from "./application.ts"
import { ElectionsMigrations } from "./migrations.ts"

const services = ExampleIdentity.layer("community-elections")

const program = ApplicationBun.runApplication(ElectionsApplication, {
  database: { migrations: ElectionsMigrations },
  services,
  ui: {
    presentation: {
      title: "Community elections",
      description: "Prepare a candidate slate, cast confidential ranked ballots, and publish aggregate election rounds.",
      operations: {
        "election.vote": {
          label: "Cast or replace my ballot",
          description: "Supply candidate UUIDs in preference order. A valid submission replaces your whole ballot while voting is open.",
        },
        "election.result": {
          label: "Read election result",
          description: "Available only after voting closes. An elimination tie is reported without an arbitrary tie-break.",
        },
      },
    },
  },
})

pipe(program, ApplicationBun.runMain, Effect.runSync)
