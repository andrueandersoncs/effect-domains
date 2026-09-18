import { Effect } from "effect"
import type { InfrastructureIR } from "effect-domains/infrastructure-compiler"

import {
  type InfrastructureBackendCapabilities,
  validateCapabilities,
} from "./backend.ts"

const capabilities: InfrastructureBackendCapabilities = {
  execution: ["request"],
  transactions: ["batch"],
  durableFilesystem: false,
  writerTopologies: ["single"],
  backupSchedules: ["none"],
  backgroundLifetime: false,
  scheduledExecution: true,
  objectStorage: true,
  queue: true,
  secrets: true,
  publicHttp: true,
  customDomains: true,
  otlp: true,
  extensions: [],
}

export const validate = Effect.fn("CloudflareInfrastructure.validate")(function* (infrastructure: InfrastructureIR) {
  return yield* validateCapabilities("Cloudflare", capabilities, infrastructure)
})

