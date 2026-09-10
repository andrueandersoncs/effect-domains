import { Effect, Path } from "effect"
import { replaceFileAtomically } from "@effect-domains/example-support/files"
import { ReportArtifactSchema, type ReportExportJob } from "./contracts.ts"
import { ReportArtifactOutput } from "./output.ts"

const isSafeExecutionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

export const writeReportArtifact = Effect.fn("ReportExports.writeReportArtifact")(
  function* (input: ReportExportJob) {
    const output = yield* ReportArtifactOutput
    const path = yield* Path.Path

    if (!isSafeExecutionId(input.executionId)) {
      return yield* Effect.die(`Unexpected workflow execution id: ${input.executionId}`)
    }

    const directory = path.resolve(output.directory)
    const artifactPath = path.join(directory, `${input.executionId}.json`)
    yield* replaceFileAtomically({ path: artifactPath, contents: input.contents })

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
  Effect.orDie,
)
