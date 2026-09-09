import { Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { NotesApplication } from "../apps/service-codec/application.ts"
import { StoragePrefix, StoredTextSchema } from "../apps/service-codec/storage.ts"
import { Application } from "effect-domains/application"
import { ApplicationBun } from "effect-domains/application-bun"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

const emptyApplication = Application.make({ name: "empty" })

const missing = ApplicationBun.run(NotesApplication, {
  database: { migrations: [] },
})

const storedPrefix = Layer.succeed(StoragePrefix, { value: "stored:" })

const storedTextGroup = RpcGroup.make(Rpc.make("stored-text", {
  payload: StoredTextSchema,
  success: StoredTextSchema,
  error: Schema.Never,
}))
const storedTextApplication = Application.make({
  name: "stored-text",
  commands: [{ group: storedTextGroup, handlers: Layer.empty }],
})
const storedTextCli = ApplicationBun.run(storedTextApplication, {
  database: { migrations: [] },
  services: storedPrefix,
})

const complete = ApplicationBun.run(NotesApplication, {
  database: { migrations: [] },
  services: storedPrefix,
})

const minimal = ApplicationBun.run(emptyApplication, {
  database: { manifest: new URL("../apps/service-codec/migrations/manifest.json", import.meta.url) },
  admin: true,
})

ApplicationBun.runMain(NotesApplication, {
  database: { migrations: [] },
  services: storedPrefix,
})

// @ts-expect-error StoragePrefix remains a requirement for a process entrypoint.
ApplicationBun.runMain(NotesApplication, { database: { migrations: [] } })

// @ts-expect-error StoredTextSchema is also needed by the CLI wire codec.
ApplicationBun.runMain(storedTextApplication, {
  database: { migrations: [] },
  services: storedPrefix,
})

// A missing storage service remains a caller requirement because it is not needed by the wire client.
const preservesMissing = true satisfies Equal<Effect.Services<typeof missing>, StoragePrefix>
const dischargesProvided = true satisfies Equal<Effect.Services<typeof complete>, never>
const defaultsAreRunnable = true satisfies Equal<Effect.Services<typeof minimal>, never>
const preservesWireCodec = true satisfies Equal<Effect.Services<typeof storedTextCli>, StoragePrefix>

const isolatesWire = true satisfies Equal<
  Rpc.ServicesClient<RpcGroup.Rpcs<typeof NotesApplication.group>>,
  never
>

void preservesMissing
void dischargesProvided
void defaultsAreRunnable
void isolatesWire
void preservesWireCodec
