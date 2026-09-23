import { BunRuntime } from "@effect/platform-bun"

export { runInfrastructure } from "./application-bun-infrastructure.ts"
export { runApplication } from "./application-bun-runtime.ts"

export const runMain = BunRuntime.runMain
