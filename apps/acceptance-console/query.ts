import { Effect } from "effect"
import { runQueryCli } from "@effect-domains/acceptance/query-cli"
import { queryApplication as expenseLedger } from "@effect-domains/example-expense-ledger/acceptance/definition"
import { queryApplication as readingList } from "@effect-domains/example-reading-list/acceptance/definition"
import { queryApplication as reportExports } from "@effect-domains/example-report-exports/acceptance/definition"
import { queryApplication as supportCases } from "@effect-domains/example-support-cases/acceptance/definition"

const help = `Product queries over the approved acceptance catalogs and retained evidence (AP-11)
bun run acceptance:query <view> [--application reading-list|support-cases|expense-ledger|report-exports|all]
  [--evidence DIR]
  [--changed ID|OPERATION|EVALUATOR] [--operation NAME] [--requirement ID] [--json]

Views
  requirements    requirement → stories, scenarios, evaluator@revision, latest evidence per build
                  (--requirement ID narrows to one requirement)
  implementation  operation → capabilities, features, stories, requirements, scenarios, inputs
                  (--operation NAME narrows to one operation)
  qa              scenarios needing a run for the current build (missing, stale build/catalog/
                  requirement/scenario/evaluator revision, blocked, inconclusive) and failures
  documentation   role-centred journeys: actor → context → need → capabilities → stories →
                  requirements → scenarios with evidence state
  gaps            capabilities without a need, needs without capabilities, requirements and
                  stories without scenarios, unbound native operations, shared-obligation refinements
  impact          --changed X: dependent declarations, scenarios and retained runs as candidates

Catalogs are the executed ones, validated with each application's own bindings; the current
build hash is computed exactly as a new run would record it. Evidence is every run.json under
DIR (default data/acceptance), decoded by its common fields; undecodable runs are listed.
Implementation status, tested conformance (per exercised scenario scope on the current build)
and validated user benefit are reported separately; benefit is "not assessed" unless a model
assessment exists, a model assessment stays unresolved until its qualitative requirement and
rubric are both approved and never counts toward passing or coverage, and a passing subset is
never reported as completion. Unfinished runs never count as current evidence. Impact
lists recorded dependencies only; unrecorded cross-feature effects may exist.
`

const program = runQueryCli([readingList, supportCases, expenseLedger, reportExports], help)

await Effect.runPromise(program)
