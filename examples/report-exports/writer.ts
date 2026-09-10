import { Effect, FileSystem, Path } from "effect"
import { ReportArtifactSchema, type ReportExportJob } from "./contracts.ts"
import { ReportArtifactOutput } from "./output.ts"

const isSafeExecutionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

export const writeReportArtifact = Effect.fn("ReportExports.writeReportArtifact")(
  function* (input: ReportExportJob) {
    const output = yield* ReportArtifactOutput
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

    return ReportArtifactSchema.make({
      artifactPath,
      reportId: input.report.reportId,
      reportingPeriod: input.report.reportingPeriod,
      currency: input.report.currency,
      releasePolicy: input.report.releasePolicy,
      releasedBy: input.releasedBy,
      lineCount: input.lines.length,
      totalDebitMinor: input.totalDebitMinor,
      totalCreditMinor: input.totalCreditMinor,
    })
  },
  Effect.scoped,
  Effect.orDie,
)
