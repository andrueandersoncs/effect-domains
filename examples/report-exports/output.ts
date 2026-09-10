import { Context } from "effect"

export class ReportArtifactOutput extends Context.Service<ReportArtifactOutput, {
  readonly directory: string
}>()("@effect-domains/example-report-exports/ReportArtifactOutput") {}
