import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import { InfrastructureCompiler } from "effect-domains/infrastructure-compiler"

import { ReadingListApplication } from "./application.ts"
import { ReadingListMigrations } from "./migrations.ts"

export const ReadingListInfrastructure = ApplicationInfrastructure.define({
  application: ReadingListApplication,
  database: {
    migrations: ReadingListMigrations,
    transactions: "interactive",
    durability: "persistent",
    writerTopology: "single",
  },
  http: {
    rpc: true,
    mcp: true,
    ui: {
      presentation: {
        title: "Reading list",
        description: "Maintain a reading backlog, record progress, and rate finished books.",
      },
    },
    public: true,
  },
})

export const ReadingListInfrastructureIR = InfrastructureCompiler.compile(ReadingListInfrastructure)
