import { Array, Effect, Schema } from "effect"
import { RunnerStorage, Sharding } from "effect/unstable/cluster"

const groupsSchema = Schema.Array(Schema.String)

class RunnerStatus extends Schema.Class<RunnerStatus>("ApplicationClusterRunnerStatus")({
  host: Schema.String,
  port: Schema.Int,
  healthy: Schema.Boolean,
  groups: groupsSchema,
  weight: Schema.Finite,
}) {}

const runnersSchema = Schema.Array(RunnerStatus)

class ClusterStatus extends Schema.Class<ClusterStatus>("ApplicationClusterStatus")({
  activeEntities: Schema.Int,
  shuttingDown: Schema.Boolean,
  runners: runnersSchema,
}) {}

// Install no routes because applications must authorize their chosen diagnostics surface.
export const ApplicationCluster = {
  Status: ClusterStatus,
  status: Effect.fn("ApplicationCluster.status")(function* () {
    const sharding = yield* Sharding.Sharding
    const storage = yield* RunnerStorage.RunnerStorage

    const snapshot = yield* Effect.all({
      activeEntities: sharding.activeEntityCount,
      shuttingDown: sharding.isShutdown,
      runners: storage.getRunners,
    })

    const runners = Array.map(snapshot.runners, ([runner, healthy]) => RunnerStatus.make({
      host: runner.address.host,
      port: runner.address.port,
      healthy,
      groups: runner.groups,
      weight: runner.weight,
    }))

    return ClusterStatus.make({ ...snapshot, runners })
  }),
}
