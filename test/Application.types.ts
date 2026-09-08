import { Effect, Layer } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { NotesApplication } from "../examples/service-codec/application.ts"
import { StoragePrefix } from "../examples/service-codec/storage.ts"
import { ApplicationBun } from "../src/application-bun.ts"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

const missing = ApplicationBun.run(NotesApplication, { database: { migrations: [] } })
const complete = ApplicationBun.run(NotesApplication, {
  database: { migrations: [] },
  services: Layer.succeed(StoragePrefix, { value: "stored:" }),
})

// A missing storage service remains a caller requirement, but never a wire requirement.
const preservesMissing = true satisfies Equal<Effect.Services<typeof missing>, StoragePrefix>
const dischargesProvided = true satisfies Equal<Effect.Services<typeof complete>, never>
const isolatesWire = true satisfies Equal<
  Rpc.ServicesClient<RpcGroup.Rpcs<typeof NotesApplication.group>>,
  never
>
void preservesMissing
void dischargesProvided
void isolatesWire
