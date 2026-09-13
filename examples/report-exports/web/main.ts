import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { field, primaryButton, quietButton, selectInput, shell, textInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Form } from "effect-domains/form"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { identitySessionView } from "@effect-domains/example-web/session"
import { IdentitySession as Session } from "effect-domains/identity-session"

import { FinancialReportLineSchema, ReportExportPollResultSchema, ReportExportRequestSchema, ReportExportStatusSchema } from "../contracts.ts"
import { ReportExportRpcs } from "../workflow.ts"

type SessionClient = Type<typeof Session.Client>

const currencies = ["AUD", "CAD", "EUR", "GBP", "JPY", "USD"] as const
const releasePolicies = ["automatic", "operatorApproval"] as const

export const WebClient = RpcService.make({ name: "report-exports/WebClient", group: ReportExportRpcs })
export type WebClient = Type<typeof WebClient>

export const Model = Schema.Struct({
  session: Session.ModelSchema,
  reportId: Schema.String, startsAt: Schema.String, endsAt: Schema.String, currency: Schema.String, releasePolicy: Schema.String,
  debitAccountCode: Schema.String, debitDescription: Schema.String, debitAmountMinor: Schema.String,
  creditAccountCode: Schema.String, creditDescription: Schema.String, creditAmountMinor: Schema.String,
  executionId: Schema.String, artifactPath: Schema.NullOr(Schema.String), releasedBy: Schema.NullOr(Schema.String), clusterStatus: Schema.NullOr(Schema.String),
  requests: RequestStateSchema,
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

const StatusSchema = ReportExportStatusSchema
export const Message = defineMessageUnion({
  SessionChanged: { message: Session.MessageSchema },
  ChangedReportId: { value: Schema.String }, ChangedStartsAt: { value: Schema.String }, ChangedEndsAt: { value: Schema.String }, ChangedCurrency: { value: Schema.String }, ChangedReleasePolicy: { value: Schema.String },
  ChangedDebitAccountCode: { value: Schema.String }, ChangedDebitDescription: { value: Schema.String }, ChangedDebitAmountMinor: { value: Schema.String }, ChangedCreditAccountCode: { value: Schema.String }, ChangedCreditDescription: { value: Schema.String }, ChangedCreditAmountMinor: { value: Schema.String }, ChangedExecutionId: { value: Schema.String },
  ClickedGenerate: {}, ClickedPoll: {}, ClickedRelease: {}, ClickedStatus: {},
  SucceededGenerate: { request: RequestTokenSchema, executionId: Schema.String }, SucceededPoll: { request: RequestTokenSchema, result: ReportExportPollResultSchema }, SucceededRelease: { request: RequestTokenSchema }, SucceededStatus: { request: RequestTokenSchema, status: StatusSchema }, Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

const requestEffect = <A, E, Success extends Message>(request: typeof RequestTokenSchema.Type, effect: Effect.Effect<A, E, WebClient>, success: (value: A) => Success) => pipe(
  effect,
  Effect.match({ onSuccess: success, onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }) }),
)
const currentToken = (session: typeof Session.ModelSchema.Type) => Session.token(session)
export const GenerateDiscard = Command.define("GenerateDiscard", {
  args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String), reportId: Schema.String, startsAt: Schema.String, endsAt: Schema.String, currency: Schema.String, releasePolicy: Schema.String, debitAccountCode: Schema.String, debitDescription: Schema.String, debitAmountMinor: Schema.String, creditAccountCode: Schema.String, creditDescription: Schema.String, creditAmountMinor: Schema.String }, messages: [Message.SucceededGenerate, Message.Failed],
  execute: (args) => requestEffect(args.request, Effect.gen(function*() {
    const request = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ReportExportRequestSchema))({ report: { reportId: args.reportId.trim(), reportingPeriod: { startsAt: args.startsAt.trim(), endsAt: args.endsAt.trim() }, currency: args.currency, releasePolicy: args.releasePolicy }, lines: [
      { accountCode: args.debitAccountCode.trim(), description: args.debitDescription.trim(), direction: "debit", amountMinor: yield* Schema.decodeUnknownEffect(Form.integer(FinancialReportLineSchema.fields.amountMinor))(args.debitAmountMinor) },
      { accountCode: args.creditAccountCode.trim(), description: args.creditDescription.trim(), direction: "credit", amountMinor: yield* Schema.decodeUnknownEffect(Form.integer(FinancialReportLineSchema.fields.amountMinor))(args.creditAmountMinor) },
    ] })
    const client = yield* WebClient
    return yield* client["ReportExport.GenerateDiscard"](request, RpcBrowser.requestOptions(args.token))
  }), (executionId) => Message.SucceededGenerate({ request: args.request, executionId })),
})
export const Poll = Command.define("Poll", { args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String), executionId: Schema.String }, messages: [Message.SucceededPoll, Message.Failed], execute: ({ request, token, executionId }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["ReportExport.Poll"]({ executionId }, RpcBrowser.requestOptions(token)))), (result) => Message.SucceededPoll({ request, result })) })
export const Release = Command.define("Release", { args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String), executionId: Schema.String }, messages: [Message.SucceededRelease, Message.Failed], execute: ({ request, token, executionId }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["ReportExport.Release"]({ executionId }, RpcBrowser.requestOptions(token)))), () => Message.SucceededRelease({ request })) })
export const Status = Command.define("Status", { args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String) }, messages: [Message.SucceededStatus, Message.Failed], execute: ({ request, token }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["ReportExport.Status"](undefined, RpcBrowser.requestOptions(token)))), (status) => Message.SucceededStatus({ request, status })) })

const start = (model: Model, key: string) => Requests.start(model.requests, key)
const pending = (model: Model, ...keys: [] | [string]) => Requests.pending(model.requests, ...keys)
const emptyForm = {
  reportId: "monthly-pnl-2026-01",
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-02-01T00:00:00.000Z",
  currency: "USD",
  releasePolicy: "operatorApproval",
  debitAccountCode: "1200",
  debitDescription: "Accounts receivable",
  debitAmountMinor: "125000",
  creditAccountCode: "4100",
  creditDescription: "Consulting revenue",
  creditAmountMinor: "125000",
}
const clearedForSession = (model: Model, session: typeof Session.ModelSchema.Type): Model => ({ ...model, ...emptyForm, session, requests: Requests.reset(model.requests), executionId: "", artifactPath: null, releasedBy: null, clusterStatus: null, notice: null })

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
    const changed = Session.generationChanged(model.session, child.model)
    return { model: changed ? clearedForSession(model, child.model) : evo(model, { session: () => child.model }), commands: child.commands }
  },
  ChangedReportId: ({ value }) => ({ model: evo(model, { reportId: () => value }) }), ChangedStartsAt: ({ value }) => ({ model: evo(model, { startsAt: () => value }) }), ChangedEndsAt: ({ value }) => ({ model: evo(model, { endsAt: () => value }) }), ChangedCurrency: ({ value }) => ({ model: evo(model, { currency: () => value }) }), ChangedReleasePolicy: ({ value }) => ({ model: evo(model, { releasePolicy: () => value }) }), ChangedDebitAccountCode: ({ value }) => ({ model: evo(model, { debitAccountCode: () => value }) }), ChangedDebitDescription: ({ value }) => ({ model: evo(model, { debitDescription: () => value }) }), ChangedDebitAmountMinor: ({ value }) => ({ model: evo(model, { debitAmountMinor: () => value }) }), ChangedCreditAccountCode: ({ value }) => ({ model: evo(model, { creditAccountCode: () => value }) }), ChangedCreditDescription: ({ value }) => ({ model: evo(model, { creditDescription: () => value }) }), ChangedCreditAmountMinor: ({ value }) => ({ model: evo(model, { creditAmountMinor: () => value }) }), ChangedExecutionId: ({ value }) => ({ model: evo(model, { executionId: () => value, artifactPath: () => null, releasedBy: () => null, requests: (current) => Requests.invalidate(Requests.invalidate(Requests.invalidate(current, "poll"), "release"), "generate"), notice: () => null }) }),
  ClickedGenerate: () => { const next = Requests.start(Requests.invalidate(Requests.invalidate(model.requests, "poll"), "release"), "generate"); return { model: evo(model, { requests: () => next.state, notice: () => null, executionId: () => "", artifactPath: () => null, releasedBy: () => null }), commands: [GenerateDiscard({ request: next.request, token: currentToken(model.session), reportId: model.reportId, startsAt: model.startsAt, endsAt: model.endsAt, currency: model.currency, releasePolicy: model.releasePolicy, debitAccountCode: model.debitAccountCode, debitDescription: model.debitDescription, debitAmountMinor: model.debitAmountMinor, creditAccountCode: model.creditAccountCode, creditDescription: model.creditDescription, creditAmountMinor: model.creditAmountMinor })] } },
  ClickedPoll: () => { const next = start(model, "poll"); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: [Poll({ request: next.request, token: currentToken(model.session), executionId: model.executionId.trim() })] } },
  ClickedRelease: () => { const next = start(model, "release"); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: [Release({ request: next.request, token: currentToken(model.session), executionId: model.executionId.trim() })] } },
  ClickedStatus: () => { const next = start(model, "status"); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: [Status({ request: next.request, token: currentToken(model.session) })] } },
  SucceededGenerate: ({ request, executionId }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.succeed(current, request), executionId: () => executionId, notice: () => ({ kind: "success" as const, text: "Export started. Poll it as an operator when it completes." }) }) } : { model },
  SucceededPoll: ({ request, result }) => { if (!Requests.accepts(model.requests, request)) return { model }; if (result._tag === "Succeeded") return { model: evo(model, { requests: (current) => Requests.succeed(current, request), artifactPath: () => result.artifactPath, releasedBy: () => result.releasedBy, notice: () => ({ kind: "success" as const, text: result.releasedBy === null ? "Export completed and awaits release." : "Export completed and was released." }) }) }; return { model: evo(model, { requests: (current) => Requests.succeed(current, request), notice: () => result._tag === "Failed" ? ({ kind: "error" as const, text: result.reason }) : ({ kind: "info" as const, text: "Export is still pending or is not known by this runner." }) }) } },
  SucceededRelease: ({ request }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: "Release approval sent. Poll the export for its artifact." }) }) } : { model },
  SucceededStatus: ({ request, status }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.succeed(current, request), clusterStatus: () => `${status.activeEntities} active export${status.activeEntities === 1 ? "" : "s"}; ${status.runners.length} runner${status.runners.length === 1 ? "" : "s"}; ${status.shuttingDown ? "shutting down" : "accepting work"}.` }) } : { model },
  Failed: ({ request, error }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.fail(current, request, error), notice: () => ({ kind: "error" as const, text: error }) }) } : { model },
})
export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({ model: { session: Session.empty(), ...emptyForm, executionId: "", artifactPath: null, releasedBy: null, clusterStatus: null, requests: Requests.empty(), notice: null } })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Report exports", body: shell(h, { title: "Report exports", lede: "Generate a balanced financial report, then use an operator session to inspect and release exports that need approval.", notice: model.notice, session: identitySessionView(h, model.session, (message) => Message.SessionChanged({ message })), children: [h.div([h.Class("split")], [
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedGenerate())], [h.h2([], ["Generate a report"]),
    field(h, { id: "report-id", label: "Report ID", children: textInput(h, { id: "report-id", value: model.reportId, onInput: (value) => Message.ChangedReportId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "starts-at", label: "Period starts at (ISO 8601 UTC)", children: textInput(h, { id: "starts-at", value: model.startsAt, onInput: (value) => Message.ChangedStartsAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "ends-at", label: "Period ends at (ISO 8601 UTC)", children: textInput(h, { id: "ends-at", value: model.endsAt, onInput: (value) => Message.ChangedEndsAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "currency", label: "Currency", children: selectInput(h, { id: "currency", value: model.currency, onChange: (value) => Message.ChangedCurrency({ value }), choices: Array.map(currencies, (value) => ({ value, label: value })) }) }), field(h, { id: "release-policy", label: "Release policy", children: selectInput(h, { id: "release-policy", value: model.releasePolicy, onChange: (value) => Message.ChangedReleasePolicy({ value }), choices: Array.map(releasePolicies, (value) => ({ value, label: value })) }) }), h.h3([], ["Sample journal pair"]),
    field(h, { id: "debit-account", label: "Debit account code", children: textInput(h, { id: "debit-account", value: model.debitAccountCode, onInput: (value) => Message.ChangedDebitAccountCode({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "debit-description", label: "Debit description", children: textInput(h, { id: "debit-description", value: model.debitDescription, onInput: (value) => Message.ChangedDebitDescription({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "debit-amount", label: "Debit amount (minor units)", children: textInput(h, { id: "debit-amount", type: "number", value: model.debitAmountMinor, onInput: (value) => Message.ChangedDebitAmountMinor({ value }), placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-account", label: "Credit account code", children: textInput(h, { id: "credit-account", value: model.creditAccountCode, onInput: (value) => Message.ChangedCreditAccountCode({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-description", label: "Credit description", children: textInput(h, { id: "credit-description", value: model.creditDescription, onInput: (value) => Message.ChangedCreditDescription({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-amount", label: "Credit amount (minor units)", children: textInput(h, { id: "credit-amount", type: "number", value: model.creditAmountMinor, onInput: (value) => Message.ChangedCreditAmountMinor({ value }), placeholder: "", autocomplete: "off" }) }), primaryButton(h, { label: pending(model, "generate") ? "Working…" : "Generate export", message: Option.none(), type: "submit", disabled: pending(model, "generate") || currentToken(model.session) === null }),
  ])]),
  h.section([h.Class("panel stack")], [h.h2([], ["Operator controls"]), h.p([], ["Report export polling, release, and cluster status require an operator session."]), field(h, { id: "execution-id", label: "Execution ID", children: textInput(h, { id: "execution-id", value: model.executionId, onInput: (value) => Message.ChangedExecutionId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), h.div([h.Class("actions")], [primaryButton(h, { label: pending(model, "poll") ? "Working…" : "Poll export", message: Option.some(Message.ClickedPoll()), type: "button", disabled: pending(model, "poll") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Release export", message: Message.ClickedRelease(), disabled: pending(model, "release") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Cluster status", message: Message.ClickedStatus(), disabled: pending(model, "status") || currentToken(model.session) === null })]), model.artifactPath === null ? h.empty : h.p([], [`Artifact: ${model.artifactPath}`]), model.releasedBy === null ? h.empty : h.p([], [`Released by: ${model.releasedBy}`]), model.clusterStatus === null ? h.empty : h.p([], [model.clusterStatus])]),
]) ] }) })
