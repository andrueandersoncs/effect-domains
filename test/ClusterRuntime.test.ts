import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, pipe } from "effect"

import {
  advanceClusterTopology,
  prepareClusterTopology,
} from "@effect-domains/example-support/cluster-runtime"

import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

it.effect("rejects topology drift and advances versions with compare-and-set", Effect.fn("ClusterRuntime.topology")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const databasePath = path.join(directory, "execution.sqlite")
  const database = SqliteBunRuntime.sqlClient(databasePath, { migrations: [] })

  yield* pipe(Effect.gen(function* () {
    yield* prepareClusterTopology("topology-test", 1, 64, ["writes", "reads"])
    yield* prepareClusterTopology("topology-test", 1, 64, ["reads", "writes"])

    const drift = yield* pipe(
      prepareClusterTopology("topology-test", 2, 64, ["reads", "writes"]),
      Effect.result,
    )

    expect(drift).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ClusterTopologyMismatch", application: "topology-test" },
    })

    yield* advanceClusterTopology({
      application: "topology-test",
      fromVersion: 1,
      toVersion: 2,
      shardsPerGroup: 128,
      shardGroups: ["default"],
    })

    yield* prepareClusterTopology("topology-test", 2, 128, ["default"])

    const stale = yield* pipe(advanceClusterTopology({
      application: "topology-test",
      fromVersion: 1,
      toVersion: 3,
      shardsPerGroup: 128,
      shardGroups: ["default"],
    }), Effect.result)

    expect(stale).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ClusterTopologyMismatch", application: "topology-test" },
    })
  }), Effect.provide(database))
}, Effect.scoped, Effect.provide(BunServices.layer)))
