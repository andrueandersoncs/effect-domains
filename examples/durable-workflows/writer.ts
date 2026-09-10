import { Effect, FileSystem, Path } from "effect"
import { ArtifactSchema, type ExportJob } from "./contracts.ts"
import { ExportOutput } from "./output.ts"

const isSafeExecutionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

export const writeExportArtifact = Effect.fn("DurableWorkflows.writeExportArtifact")(
  function* (input: ExportJob) {
    const output = yield* ExportOutput
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    if (!isSafeExecutionId(input.executionId)) {
      return yield* Effect.die(`Unexpected workflow execution id: ${input.executionId}`)
    }

    const directory = path.resolve(output.directory)
    const artifactPath = path.join(directory, `${input.executionId}.json`)
    yield* fileSystem.makeDirectory(directory, { recursive: true })
    const temporary = yield* fileSystem.makeTempFileScoped({ directory, prefix: `.${input.executionId}.` })
    yield* fileSystem.writeFileString(temporary, input.contents)
    yield* fileSystem.rename(temporary, artifactPath)

    return ArtifactSchema.make({ artifactPath, recordCount: input.recordCount })
  },
  Effect.scoped,
  Effect.orDie,
)
