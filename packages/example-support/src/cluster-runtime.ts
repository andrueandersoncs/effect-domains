import { BunClusterHttp } from "@effect/platform-bun"

import {
  Array,
  Config,
  Effect,
  Equivalence,
  Layer,
  Option,
  Order,
  Schema,
  flow,
  pipe,
} from "effect"

import {
  RunnerAddress,
  ShardingConfig,
  SingleRunner,
  SqlRunnerStorage,
} from "effect/unstable/cluster"

import { SqlClient } from "effect/unstable/sql"

export const ClusterModeSchema = Schema.Literals(["single", "runner", "client"])

export const clusterMode = pipe(
  Config.schema(ClusterModeSchema, "EFFECT_CLUSTER_MODE"),
  Config.withDefault("single" as const),
)

const same = Equivalence.strictEqual<unknown>()

const selectWorkerLayer = Effect.fn("ExampleCluster.selectWorkerLayer")(function* <A, E, R>(
  layer: Layer.Layer<A, E, R>,
) {
  const mode = yield* clusterMode
  return same(mode, "client") ? Layer.empty : layer
})

export const clusterWorkerLayer = <A, E, R>(layer: Layer.Layer<A, E, R>) => pipe(
  selectWorkerLayer(layer),
  Layer.unwrap,
)

class ClusterTopologyMismatch extends Schema.TaggedError<ClusterTopologyMismatch>()(
  "ClusterTopologyMismatch",
  {
    application: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

interface ClusterTopologyUpgrade {
  readonly application: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly shardGroups: ReadonlyArray<string>
  readonly shardsPerGroup: number
}

interface TopologyRow {
  readonly topologyVersion: number
  readonly shardsPerGroup: number
  readonly shardGroups: string
}

const ClusterTopologySchema = Schema.Struct({
  topologyVersion: Schema.Number,
  shardsPerGroup: Schema.Number,
  shardGroups: Schema.Array(Schema.String),
})

const stringArrayToJson = flow(Array.sort(Order.String), JSON.stringify)

const topologyMismatch = (
  application: string,
  expected: unknown,
  actual: unknown,
) => ClusterTopologyMismatch.make({
  application,
  expected: JSON.stringify(expected),
  actual: JSON.stringify(actual),
})

export const prepareClusterTopology = Effect.fn("ExampleCluster.prepareTopology")(function* (
  application: string,
  topologyVersion: number,
  shardsPerGroup: number,
  shardGroups: ReadonlyArray<string>,
) {
  const database = yield* SqlClient.SqlClient
  const serializedGroups = stringArrayToJson(shardGroups)

  yield* database`
    CREATE TABLE IF NOT EXISTS effect_domains_cluster_topology (
      application TEXT PRIMARY KEY NOT NULL,
      topologyVersion INTEGER NOT NULL,
      shardsPerGroup INTEGER NOT NULL,
      shardGroups TEXT NOT NULL
    )
  `

  yield* database`
    INSERT INTO effect_domains_cluster_topology
      (application, topologyVersion, shardsPerGroup, shardGroups)
    VALUES (${application}, ${topologyVersion}, ${shardsPerGroup}, ${serializedGroups})
    ON CONFLICT(application) DO NOTHING
  `

  const rows = yield* database<Readonly<TopologyRow>>`
    SELECT topologyVersion, shardsPerGroup, shardGroups
    FROM effect_domains_cluster_topology
    WHERE application = ${application}
  `

  const actual = Array.head(rows)
  const sortedGroups = pipe(shardGroups, Array.sort(Order.String))
  const expected = ClusterTopologySchema.make({ topologyVersion, shardsPerGroup, shardGroups: sortedGroups })

  if (Option.isNone(actual)) {
    return yield* topologyMismatch(application, expected, null)
  }

  const matching = [
    same(actual.value.topologyVersion, topologyVersion),
    same(actual.value.shardsPerGroup, shardsPerGroup),
    same(actual.value.shardGroups, serializedGroups),
  ]

  if (Array.every(matching, Boolean)) return

  return yield* topologyMismatch(application, expected, actual.value)
})

export const advanceClusterTopology = Effect.fn("ExampleCluster.advanceTopology")(function* (
  upgrade: ClusterTopologyUpgrade,
) {
  const database = yield* SqlClient.SqlClient
  const shardGroups = stringArrayToJson(upgrade.shardGroups)

  const changed = yield* database.withTransaction(database<Readonly<{ topologyVersion: number }>>`
    UPDATE effect_domains_cluster_topology
    SET topologyVersion = ${upgrade.toVersion},
        shardsPerGroup = ${upgrade.shardsPerGroup},
        shardGroups = ${shardGroups}
    WHERE application = ${upgrade.application}
      AND topologyVersion = ${upgrade.fromVersion}
      AND ${upgrade.toVersion} > ${upgrade.fromVersion}
    RETURNING topologyVersion
  `)

  const changedHead = Array.head(changed)
  if (Option.isSome(changedHead)) return

  const rows = yield* database<Readonly<TopologyRow>>`
    SELECT topologyVersion, shardsPerGroup, shardGroups
    FROM effect_domains_cluster_topology
    WHERE application = ${upgrade.application}
  `

  const rowsHead = Array.head(rows)
  const actual = Option.getOrNull(rowsHead)

  return yield* topologyMismatch(upgrade.application, upgrade, actual)
})

const makeClusterRuntime = Effect.fn("ExampleCluster.makeRuntime")(function* (
  application: string,
  topologyVersion: number,
) {
  const mode = yield* clusterMode
  const host = yield* pipe(Config.string("EFFECT_CLUSTER_HOST"), Config.withDefault("127.0.0.1"))
  const port = yield* pipe(Config.int("EFFECT_CLUSTER_PORT"), Config.withDefault(34431))
  const listenHost = yield* pipe(Config.string("EFFECT_CLUSTER_LISTEN_HOST"), Config.withDefault(host))
  const listenPort = yield* pipe(Config.int("EFFECT_CLUSTER_LISTEN_PORT"), Config.withDefault(port))
  const shardGroups = ["default"]
  const shardsPerGroup = 64

  yield* prepareClusterTopology(application, topologyVersion, shardsPerGroup, shardGroups)

  const runnerStorageConfig = ShardingConfig.layer({
    availableShardGroups: shardGroups,
    assignedShardGroups: shardGroups,
    shardsPerGroup,
  })

  const runnerStorage = pipe(SqlRunnerStorage.layer, Layer.provide(runnerStorageConfig))

  if (same(mode, "single")) {
    return pipe(
      SingleRunner.layer({ shardingConfig: { availableShardGroups: shardGroups, assignedShardGroups: shardGroups, shardsPerGroup } }),
      Layer.provideMerge(runnerStorage),
    )
  }

  if (same(mode, "client")) {
    const noRunnerAddress = Option.none()
    const noRunnerListenAddress = Option.none()

    return pipe(
      BunClusterHttp.layer({
        transport: "http",
        storage: "sql",
        clientOnly: true,
        shardingConfig: {
          availableShardGroups: shardGroups,
          assignedShardGroups: shardGroups,
          shardsPerGroup,
          runnerAddress: noRunnerAddress,
          runnerListenAddress: noRunnerListenAddress,
        },
      }),
      Layer.provideMerge(runnerStorage),
    )
  }

  const runnerAddress = RunnerAddress.make(host, port)
  const runnerListenAddress = RunnerAddress.make(listenHost, listenPort)
  const configuredRunnerAddress = Option.some(runnerAddress)
  const configuredRunnerListenAddress = Option.some(runnerListenAddress)

  return pipe(
    BunClusterHttp.layer({
      transport: "http",
      storage: "sql",
      shardingConfig: {
        availableShardGroups: shardGroups,
        assignedShardGroups: shardGroups,
        shardsPerGroup,
        runnerAddress: configuredRunnerAddress,
        runnerListenAddress: configuredRunnerListenAddress,
      },
    }),
    Layer.provideMerge(runnerStorage),
  )
})

export const clusterRuntimeLayer = (application: string, topologyVersion: number) => pipe(
  makeClusterRuntime(application, topologyVersion),
  Layer.unwrap,
)
