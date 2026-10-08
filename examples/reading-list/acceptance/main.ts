import { Effect, Schema } from "effect"
import { resolve, join } from "node:path"
import { evidenceLayer } from "./evidence.ts"
import { AcceptanceError } from "./model.ts"
import { runAcceptance, type RunConfiguration } from "./runner.ts"

const ConfigurationSchema = Schema.Struct({
  output: Schema.NonEmptyString,
  seed: Schema.Int,
  model: Schema.NonEmptyString,
  minimumConfidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  maxActions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  deadlineSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(600)),
  replay: Schema.optionalKey(Schema.NonEmptyString),
})
const help = `Reading List Slice A: real Jev exploration and browser acceptance
bun run reading-list:acceptance [--output PATH] [--seed INTEGER] [--model ID]
  [--minimum-confidence 0..1] [--max-actions 1..100] [--deadline-seconds 1..600]
bun run reading-list:acceptance --replay PATH/run.json [--output PATH]

Exploration requires TYPESAFE_API_KEY. Replay uses captured concrete inputs/actions,
rebinds fixture identity, and rejects stale builds/specifications rather than repairing
or skipping obligations. Every run launches isolated actual Reading List servers and
fresh Chromium contexts. Run 'bun run build' and 'bunx playwright install chromium'
first. Evidence is private local JSON + screenshots/logs, not production-safe data.
Nonzero exit: Slice A not passed, prerequisites failed, or evidence could not be saved.
All SDA completion entries remain open; this is internally guided functional QA.
`

if (process.argv.includes("--help")) {
  console.log(help)
} else {
  const program = Effect.gen(function* () {
    const configuration = yield* Effect.try({
      try: () => {
        const args = process.argv.slice(2)
        const options: Record<string, string> = {}
        const allowed = ["--output", "--seed", "--model", "--minimum-confidence", "--max-actions", "--deadline-seconds", "--replay"]
        for (let index = 0; index < args.length; index += 2) {
          const name = args[index]!
          const value = args[index + 1]
          if (!allowed.includes(name) || !value || Object.hasOwn(options, name)) throw new AcceptanceError({ boundary: "runtime", message: `Unknown, repeated, or incomplete option ${name}` })
          options[name] = value
        }
        const root = new URL("../../../", import.meta.url).pathname
        const values = Schema.decodeUnknownSync(ConfigurationSchema)({
          output: options["--output"] ? resolve(options["--output"]) : join(root, "data", "acceptance", `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`),
          seed: Number(options["--seed"] ?? 42),
          model: options["--model"] ?? "jev-1.13.0",
          minimumConfidence: Number(options["--minimum-confidence"] ?? 0.55),
          maxActions: Number(options["--max-actions"] ?? 30),
          deadlineSeconds: Number(options["--deadline-seconds"] ?? 180),
          ...(options["--replay"] ? { replay: resolve(options["--replay"]) } : {}),
        })
        return { ...values, ...(process.env.TYPESAFE_API_KEY ? { apiKey: process.env.TYPESAFE_API_KEY } : {}) } satisfies RunConfiguration
      },
      catch: (error) => new AcceptanceError({ boundary: "configuration", message: String(error) }),
    })
    const passed = yield* runAcceptance(configuration).pipe(Effect.provide(evidenceLayer))
    process.exitCode = passed ? 0 : 1
  })
  await Effect.runPromise(program).catch((error: unknown) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
