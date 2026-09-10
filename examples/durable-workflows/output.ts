import { Context } from "effect"

export class ExportOutput extends Context.Service<ExportOutput, {
  readonly directory: string
}>()("@effect-domains/example-durable-workflows/ExportOutput") {}
