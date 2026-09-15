import { Array, Effect, Option, Schema, pipe } from "effect"
import { Runtime, type Update } from "foldkit"
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
  ClickedGenerate: {}, ClickedPoll: {}, ClickedRelease: {}, ClickedResume: {}, ClickedCancel: {}, ClickedReconcile: {}, ClickedStatus: {},
  SucceededGenerate: { request: RequestTokenSchema, executionId: Schema.String }, SucceededPoll: { request: RequestTokenSchema, result: ReportExportPollResultSchema }, SucceededAction: { request: RequestTokenSchema, action: Schema.Literals(["released", "resumed", "cancelled"]) }, SucceededStatus: { request: RequestTokenSchema, status: StatusSchema }, Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

const currentToken = (session: typeof Session.ModelSchema.Type) => Session.token(session)
export const GenerateDiscard = RpcBrowser.command("GenerateDiscard", {
  request: "generate",
  args: {
    token: Schema.NullOr(Schema.String),
    reportId: Schema.String,
    startsAt: Schema.String,
    endsAt: Schema.String,
    currency: Schema.String,
    releasePolicy: Schema.String,
    debitAccountCode: Schema.String,
    debitDescription: Schema.String,
    debitAmountMinor: Schema.String,
    creditAccountCode: Schema.String,
    creditDescription: Schema.String,
    creditAmountMinor: Schema.String,
  },
  success: Message.SucceededGenerate,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const request = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ReportExportRequestSchema))({
      report: {
        reportId: args.reportId.trim(),
        reportingPeriod: { startsAt: args.startsAt.trim(), endsAt: args.endsAt.trim() },
        currency: args.currency,
        releasePolicy: args.releasePolicy,
      },
      lines: [
        {
          accountCode: args.debitAccountCode.trim(),
          description: args.debitDescription.trim(),
          direction: "debit",
          amountMinor: yield* Schema.decodeUnknownEffect(Form.integer(FinancialReportLineSchema.fields.amountMinor))(
            args.debitAmountMinor,
          ),
        },
        {
          accountCode: args.creditAccountCode.trim(),
          description: args.creditDescription.trim(),
          direction: "credit",
          amountMinor: yield* Schema.decodeUnknownEffect(Form.integer(FinancialReportLineSchema.fields.amountMinor))(
            args.creditAmountMinor,
          ),
        },
      ],
    })
    const client = yield* WebClient
    const executionId = yield* client["ReportExport.GenerateDiscard"](
      request,
      RpcBrowser.requestOptions(args.token),
    )

    return { executionId }
  }),
})

export const Poll = RpcBrowser.command("Poll", {
  request: "poll",
  args: { token: Schema.NullOr(Schema.String), executionId: Schema.String },
  success: Message.SucceededPoll,
  failure: Message.Failed,
  execute: ({ token, executionId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.Poll"]({ executionId }, RpcBrowser.requestOptions(token))),
    Effect.map((result) => ({ result })),
  ),
})

export const Release = RpcBrowser.command("Release", {
  request: "release",
  args: { token: Schema.NullOr(Schema.String), executionId: Schema.String },
  success: Message.SucceededAction,
  failure: Message.Failed,
  execute: ({ token, executionId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.Release"]({ executionId }, RpcBrowser.requestOptions(token))),
    Effect.as({ action: "released" as const }),
  ),
})

export const Resume = RpcBrowser.command("Resume", {
  request: "resume",
  args: { token: Schema.NullOr(Schema.String), executionId: Schema.String },
  success: Message.SucceededAction,
  failure: Message.Failed,
  execute: ({ token, executionId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.GenerateResume"]({ executionId }, RpcBrowser.requestOptions(token))),
    Effect.as({ action: "resumed" as const }),
  ),
})

export const Cancel = RpcBrowser.command("Cancel", {
  request: "cancel",
  args: { token: Schema.NullOr(Schema.String), executionId: Schema.String },
  success: Message.SucceededAction,
  failure: Message.Failed,
  execute: ({ token, executionId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.Cancel"]({ executionId }, RpcBrowser.requestOptions(token))),
    Effect.as({ action: "cancelled" as const }),
  ),
})

export const Reconcile = RpcBrowser.command("Reconcile", {
  request: "reconcile",
  args: { token: Schema.NullOr(Schema.String), executionId: Schema.String },
  success: Message.SucceededPoll,
  failure: Message.Failed,
  execute: ({ token, executionId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.Reconcile"]({ executionId }, RpcBrowser.requestOptions(token))),
    Effect.map((artifact) => ({
      result: ReportExportPollResultSchema.make({ _tag: "Succeeded", ...artifact }),
    })),
  ),
})

export const Status = RpcBrowser.command("Status", {
  request: "status",
  args: { token: Schema.NullOr(Schema.String) },
  success: Message.SucceededStatus,
  failure: Message.Failed,
  execute: ({ token }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["ReportExport.Status"](undefined, RpcBrowser.requestOptions(token))),
    Effect.map((status) => ({ status })),
  ),
})

const pending = (model: Model, ...keys: [] | [string]) => RpcBrowser.pending(model, ...keys)
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
const clearedForSession = (model: Model, session: typeof Session.ModelSchema.Type): Model =>
  RpcBrowser.reset(model, { ...emptyForm, session, executionId: "", artifactPath: null, releasedBy: null, clusterStatus: null, notice: null }).model

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
    const changed = Session.generationChanged(model.session, child.model)
    return { model: changed ? clearedForSession(model, child.model) : evo(model, { session: () => child.model }), commands: child.commands }
  },
  ChangedReportId: ({ value }) => ({ model: evo(model, { reportId: () => value }) }),
  ChangedStartsAt: ({ value }) => ({ model: evo(model, { startsAt: () => value }) }),
  ChangedEndsAt: ({ value }) => ({ model: evo(model, { endsAt: () => value }) }),
  ChangedCurrency: ({ value }) => ({ model: evo(model, { currency: () => value }) }),
  ChangedReleasePolicy: ({ value }) => ({ model: evo(model, { releasePolicy: () => value }) }),
  ChangedDebitAccountCode: ({ value }) => ({ model: evo(model, { debitAccountCode: () => value }) }),
  ChangedDebitDescription: ({ value }) => ({ model: evo(model, { debitDescription: () => value }) }),
  ChangedDebitAmountMinor: ({ value }) => ({ model: evo(model, { debitAmountMinor: () => value }) }),
  ChangedCreditAccountCode: ({ value }) => ({ model: evo(model, { creditAccountCode: () => value }) }),
  ChangedCreditDescription: ({ value }) => ({ model: evo(model, { creditDescription: () => value }) }),
  ChangedCreditAmountMinor: ({ value }) => ({ model: evo(model, { creditAmountMinor: () => value }) }),
  ChangedExecutionId: ({ value }) => {
    const withoutPoll = RpcBrowser.invalidate(model, Poll.requestKey).model
    const withoutRelease = RpcBrowser.invalidate(withoutPoll, Release.requestKey).model
    return RpcBrowser.invalidate(withoutRelease, GenerateDiscard.requestKey, {
      executionId: value,
      artifactPath: null,
      releasedBy: null,
      notice: null,
    })
  },
  ClickedGenerate: () => {
    const withoutPoll = RpcBrowser.invalidate(model, Poll.requestKey).model
    const withoutRelease = RpcBrowser.invalidate(withoutPoll, Release.requestKey).model
    return GenerateDiscard.start(withoutRelease, {
      token: currentToken(model.session),
      reportId: model.reportId,
      startsAt: model.startsAt,
      endsAt: model.endsAt,
      currency: model.currency,
      releasePolicy: model.releasePolicy,
      debitAccountCode: model.debitAccountCode,
      debitDescription: model.debitDescription,
      debitAmountMinor: model.debitAmountMinor,
      creditAccountCode: model.creditAccountCode,
      creditDescription: model.creditDescription,
      creditAmountMinor: model.creditAmountMinor,
    }, { notice: null, executionId: "", artifactPath: null, releasedBy: null })
  },
  ClickedPoll: () => Poll.start(model, { token: currentToken(model.session), executionId: model.executionId.trim() }, { notice: null }),
  ClickedRelease: () => Release.start(model, { token: currentToken(model.session), executionId: model.executionId.trim() }, { notice: null }),
  ClickedResume: () => Resume.start(model, { token: currentToken(model.session), executionId: model.executionId.trim() }, { notice: null }),
  ClickedCancel: () => Cancel.start(model, { token: currentToken(model.session), executionId: model.executionId.trim() }, { notice: null }),
  ClickedReconcile: () => Reconcile.start(model, { token: currentToken(model.session), executionId: model.executionId.trim() }, { notice: null }),
  ClickedStatus: () => Status.start(model, { token: currentToken(model.session) }, { notice: null }),
  SucceededGenerate: ({ request, executionId }) => RpcBrowser.succeed(model, request, {
    executionId,
    notice: { kind: "success" as const, text: "Export accepted durably. Poll it as an operator." },
  }),
  SucceededPoll: ({ request, result }) => {
    if (result._tag === "Succeeded") return RpcBrowser.succeed(model, request, {
      artifactPath: result.artifactPath,
      releasedBy: result.releasedBy,
      notice: { kind: "success" as const, text: "Export artifact is reconciled." },
    })

    const text = result._tag === "Failed" || result._tag === "Recoverable"
      ? result.reason
      : result._tag === "Cancelled"
      ? "Export was cancelled."
      : result._tag === "Unknown"
      ? "No durable export has that execution ID."
      : `Export is ${result.stage}.`
    const kind = result._tag === "Failed" ? "error" as const : "info" as const
    return RpcBrowser.succeed(model, request, { notice: { kind, text } })
  },
  SucceededAction: ({ request, action }) => RpcBrowser.succeed(model, request, {
    notice: { kind: "success" as const, text: `Export ${action}. Poll for its current durable state.` },
  }),
  SucceededStatus: ({ request, status }) => RpcBrowser.succeed(model, request, {
    clusterStatus: `${status.activeEntities} active export${status.activeEntities === 1 ? "" : "s"}; ${status.runners.length} runner${status.runners.length === 1 ? "" : "s"}; ${status.shuttingDown ? "shutting down" : "accepting work"}.`,
  }),
  Failed: ({ request, error }) => RpcBrowser.fail(model, request, error, {
    notice: { kind: "error" as const, text: error },
  }),
})
export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({ model: { session: Session.empty(), ...emptyForm, executionId: "", artifactPath: null, releasedBy: null, clusterStatus: null, requests: Requests.empty(), notice: null } })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Report exports", body: shell(h, { title: "Report exports", lede: "Generate a balanced financial report, then use an operator session to inspect and release exports that need approval.", notice: model.notice, session: identitySessionView(h, model.session, (message) => Message.SessionChanged({ message })), children: [h.div([h.Class("split")], [
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedGenerate())], [h.h2([], ["Generate a report"]),
    field(h, { id: "report-id", label: "Report ID", children: textInput(h, { id: "report-id", value: model.reportId, onInput: (value) => Message.ChangedReportId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "starts-at", label: "Period starts at (ISO 8601 UTC)", children: textInput(h, { id: "starts-at", value: model.startsAt, onInput: (value) => Message.ChangedStartsAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "ends-at", label: "Period ends at (ISO 8601 UTC)", children: textInput(h, { id: "ends-at", value: model.endsAt, onInput: (value) => Message.ChangedEndsAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "currency", label: "Currency", children: selectInput(h, { id: "currency", value: model.currency, onChange: (value) => Message.ChangedCurrency({ value }), choices: Array.map(currencies, (value) => ({ value, label: value })) }) }), field(h, { id: "release-policy", label: "Release policy", children: selectInput(h, { id: "release-policy", value: model.releasePolicy, onChange: (value) => Message.ChangedReleasePolicy({ value }), choices: Array.map(releasePolicies, (value) => ({ value, label: value })) }) }), h.h3([], ["Sample journal pair"]),
    field(h, { id: "debit-account", label: "Debit account code", children: textInput(h, { id: "debit-account", value: model.debitAccountCode, onInput: (value) => Message.ChangedDebitAccountCode({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "debit-description", label: "Debit description", children: textInput(h, { id: "debit-description", value: model.debitDescription, onInput: (value) => Message.ChangedDebitDescription({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "debit-amount", label: "Debit amount (minor units)", children: textInput(h, { id: "debit-amount", type: "number", value: model.debitAmountMinor, onInput: (value) => Message.ChangedDebitAmountMinor({ value }), placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-account", label: "Credit account code", children: textInput(h, { id: "credit-account", value: model.creditAccountCode, onInput: (value) => Message.ChangedCreditAccountCode({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-description", label: "Credit description", children: textInput(h, { id: "credit-description", value: model.creditDescription, onInput: (value) => Message.ChangedCreditDescription({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "credit-amount", label: "Credit amount (minor units)", children: textInput(h, { id: "credit-amount", type: "number", value: model.creditAmountMinor, onInput: (value) => Message.ChangedCreditAmountMinor({ value }), placeholder: "", autocomplete: "off" }) }), primaryButton(h, { label: pending(model, "generate") ? "Working…" : "Generate export", message: Option.none(), type: "submit", disabled: pending(model, "generate") || currentToken(model.session) === null }),
  ])]),
  h.section([h.Class("panel stack")], [h.h2([], ["Operator controls"]), h.p([], ["Polling, release, recovery, cancellation, reconciliation, and cluster status require an operator session."]), field(h, { id: "execution-id", label: "Execution ID", children: textInput(h, { id: "execution-id", value: model.executionId, onInput: (value) => Message.ChangedExecutionId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), h.div([h.Class("actions")], [primaryButton(h, { label: pending(model, "poll") ? "Working…" : "Poll export", message: Option.some(Message.ClickedPoll()), type: "button", disabled: pending(model, "poll") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Release", message: Message.ClickedRelease(), disabled: pending(model, "release") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Resume", message: Message.ClickedResume(), disabled: pending(model, "resume") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Cancel", message: Message.ClickedCancel(), disabled: pending(model, "cancel") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Reconcile artifact", message: Message.ClickedReconcile(), disabled: pending(model, "reconcile") || model.executionId.trim() === "" || currentToken(model.session) === null }), quietButton(h, { label: "Cluster status", message: Message.ClickedStatus(), disabled: pending(model, "status") || currentToken(model.session) === null })]), model.artifactPath === null ? h.empty : h.p([], [`Artifact: ${model.artifactPath}`]), model.releasedBy === null ? h.empty : h.p([], [`Released by: ${model.releasedBy}`]), model.clusterStatus === null ? h.empty : h.p([], [model.clusterStatus])]),
]) ] }) })
