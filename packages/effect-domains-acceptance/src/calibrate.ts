import { Effect } from "effect"
import { runCalibrationCli } from "./cli.ts"

const help = `Held-out decision calibration (AP-09): real Jev calls over reviewed corpora
bun run acceptance:calibrate --corpora PATH[,PATH...] --models ID[,ID...] --output DIR [--minimum-confidence 0..1]

Each item is asked once per model in declared, reversed, and rotated option order. Every trial,
the corpus with its review record, and per-model summaries are retained in DIR/calibration.json
(never overwritten). Requires TYPESAFE_API_KEY; there is no mock fallback. Results describe this
finite corpus only; they do not prove correct choices elsewhere.
`

const program = runCalibrationCli(help)

await Effect.runPromise(program)
