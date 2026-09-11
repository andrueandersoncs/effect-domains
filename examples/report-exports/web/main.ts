import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  field,
  primaryButton,
  quietButton,
  selectInput,
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"

const currencies = ["AUD", "CAD", "EUR", "GBP", "JPY", "USD"]
const releasePolicies = ["automatic", "operatorApproval"]

const PollResultSchema = Schema.Union([
  Schema.TaggedStruct("PendingOrUnknown", {}),
  Schema.TaggedStruct("Succeeded", {
    artifactPath: Schema.String,
    releasedBy: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])

const StatusSchema = Schema.Struct({
  activeEntities: Schema.Int,
  shuttingDown: Schema.Boolean,
  runners: Schema.Array(Schema.Unknown),
})

export const Model = Schema.Struct({
  token: Schema.String,
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
  executionId: Schema.String,
  artifactPath: Schema.NullOr(Schema.String),
  releasedBy: Schema.NullOr(Schema.String),
  clusterStatus: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedToken: { value: Schema.String },
  SelectedToken: { token: Schema.String },
  ChangedReportId: { value: Schema.String },
  ChangedStartsAt: { value: Schema.String },
  ChangedEndsAt: { value: Schema.String },
  ChangedCurrency: { value: Schema.String },
  ChangedReleasePolicy: { value: Schema.String },
  ChangedDebitAccountCode: { value: Schema.String },
  ChangedDebitDescription: { value: Schema.String },
  ChangedDebitAmountMinor: { value: Schema.String },
  ChangedCreditAccountCode: { value: Schema.String },
  ChangedCreditDescription: { value: Schema.String },
  ChangedCreditAmountMinor: { value: Schema.String },
  ChangedExecutionId: { value: Schema.String },
  ClickedGenerate: {},
  ClickedPoll: {},
  ClickedRelease: {},
  ClickedStatus: {},
  SucceededGenerate: { executionId: Schema.String },
  SucceededPoll: { result: PollResultSchema },
  SucceededRelease: {},
  SucceededStatus: { activeEntities: Schema.Int, shuttingDown: Schema.Boolean, runnerCount: Schema.Int },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

export const GenerateDiscard = Command.define("GenerateDiscard", {
  args: {
    token: Schema.String,
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
  messages: [Message.SucceededGenerate, Message.Failed],
  execute: (args) =>
    pipe(
      rpcCall({
        tag: "ReportExport.GenerateDiscard",
        payload: {
          report: {
            reportId: args.reportId.trim(),
            reportingPeriod: {
              startsAt: args.startsAt.trim(),
              endsAt: args.endsAt.trim(),
            },
            currency: args.currency,
            releasePolicy: args.releasePolicy,
          },
          lines: [
            {
              accountCode: args.debitAccountCode.trim(),
              description: args.debitDescription.trim(),
              direction: "debit",
              amountMinor: Number.parseInt(args.debitAmountMinor, 10),
            },
            {
              accountCode: args.creditAccountCode.trim(),
              description: args.creditDescription.trim(),
              direction: "credit",
              amountMinor: Number.parseInt(args.creditAmountMinor, 10),
            },
          ],
        },
        token: args.token,
        success: Schema.String,
      }),
      Effect.match({
        onSuccess: (executionId) => Message.SucceededGenerate({ executionId }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const Poll = Command.define("Poll", {
  args: { token: Schema.String, executionId: Schema.String },
  messages: [Message.SucceededPoll, Message.Failed],
  execute: ({ token, executionId }) =>
    pipe(
      rpcCall({
        tag: "ReportExport.Poll",
        payload: { executionId },
        token,
        success: PollResultSchema,
      }),
      Effect.match({
        onSuccess: (result) => Message.SucceededPoll({ result }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const Release = Command.define("Release", {
  args: { token: Schema.String, executionId: Schema.String },
  messages: [Message.SucceededRelease, Message.Failed],
  execute: ({ token, executionId }) =>
    pipe(
      rpcCall({
        tag: "ReportExport.Release",
        payload: { executionId },
        token,
        success: Schema.Void,
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRelease(),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const Status = Command.define("Status", {
  args: { token: Schema.String },
  messages: [Message.SucceededStatus, Message.Failed],
  execute: ({ token }) =>
    pipe(
      rpcCall({
        tag: "ReportExport.Status",
        payload: undefined,
        token,
        success: StatusSchema,
      }),
      Effect.match({
        onSuccess: (status) => Message.SucceededStatus({
          activeEntities: status.activeEntities,
          shuttingDown: status.shuttingDown,
          runnerCount: status.runners.length,
        }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedToken: ({ value }) => ({ model: evo(model, { token: () => value }) }),
    SelectedToken: ({ token }) => ({ model: evo(model, { token: () => token }) }),
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
    ChangedExecutionId: ({ value }) => ({ model: evo(model, { executionId: () => value }) }),
    ClickedGenerate: () => ({
      model: evo(model, { busy: () => true, notice: () => null, artifactPath: () => null, releasedBy: () => null }),
      commands: [GenerateDiscard({
        token: model.token,
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
      })],
    }),
    ClickedPoll: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [Poll({ token: model.token, executionId: model.executionId.trim() })],
    }),
    ClickedRelease: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [Release({ token: model.token, executionId: model.executionId.trim() })],
    }),
    ClickedStatus: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [Status({ token: model.token })],
    }),
    SucceededGenerate: ({ executionId }) => ({
      model: evo(model, {
        busy: () => false,
        executionId: () => executionId,
        notice: () => ({ kind: "success" as const, text: "Export started. Switch to admin to poll or release it." }),
      }),
    }),
    SucceededPoll: ({ result }) => {
      if (result._tag === "Succeeded") {
        return {
          model: evo(model, {
            busy: () => false,
            artifactPath: () => result.artifactPath,
            releasedBy: () => result.releasedBy,
            notice: () => ({
              kind: "success" as const,
              text: result.releasedBy === null ? "Export completed and awaits release." : "Export completed and was released.",
            }),
          }),
        }
      }

      if (result._tag === "Failed") {
        return {
          model: evo(model, {
            busy: () => false,
            notice: () => ({ kind: "error" as const, text: result.reason }),
          }),
        }
      }

      return {
        model: evo(model, {
          busy: () => false,
          notice: () => ({ kind: "info" as const, text: "Export is still pending or is not known by this runner." }),
        }),
      }
    },
    SucceededRelease: () => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "success" as const, text: "Release approval sent. Poll the export for its artifact." }),
      }),
    }),
    SucceededStatus: ({ activeEntities, shuttingDown, runnerCount }) => ({
      model: evo(model, {
        busy: () => false,
        clusterStatus: () => `${activeEntities} active export${activeEntities === 1 ? "" : "s"}; ${runnerCount} runner${runnerCount === 1 ? "" : "s"}; ${shuttingDown ? "shutting down" : "accepting work"}.`,
      }),
    }),
    Failed: ({ error }) => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    token: "alice-demo",
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
    executionId: "",
    artifactPath: null,
    releasedBy: null,
    clusterStatus: null,
    busy: false,
    notice: null,
  },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Report exports",
  body: shell(h, {
    title: "Report exports",
    lede: "Generate a balanced financial report as Alice, then switch to admin to inspect and release exports that need approval.",
    notice: model.notice,
    session: {
      token: model.token,
      onInput: (value) => Message.ChangedToken({ value }),
      onSelect: (token) => Message.SelectedToken({ token }),
    },
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedGenerate())],
                [
                  h.h2([], ["Generate a report"]),
                  field(h, {
                    id: "report-id",
                    label: "Report ID",
                    children: textInput(h, {
                      id: "report-id",
                      value: model.reportId,
                      onInput: (value) => Message.ChangedReportId({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "starts-at",
                    label: "Period starts at (ISO 8601)",
                    children: textInput(h, {
                      id: "starts-at",
                      value: model.startsAt,
                      onInput: (value) => Message.ChangedStartsAt({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "ends-at",
                    label: "Period ends at (ISO 8601)",
                    children: textInput(h, {
                      id: "ends-at",
                      value: model.endsAt,
                      onInput: (value) => Message.ChangedEndsAt({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "currency",
                    label: "Currency",
                    children: selectInput(h, {
                      id: "currency",
                      value: model.currency,
                      onChange: (value) => Message.ChangedCurrency({ value }),
                      choices: Array.map(currencies, (currency) => ({ value: currency, label: currency })),
                    }),
                  }),
                  field(h, {
                    id: "release-policy",
                    label: "Release policy",
                    children: selectInput(h, {
                      id: "release-policy",
                      value: model.releasePolicy,
                      onChange: (value) => Message.ChangedReleasePolicy({ value }),
                      choices: Array.map(releasePolicies, (policy) => ({ value: policy, label: policy })),
                    }),
                  }),
                  h.h3([], ["Sample journal pair"]),
                  field(h, {
                    id: "debit-account",
                    label: "Debit account code",
                    children: textInput(h, {
                      id: "debit-account",
                      value: model.debitAccountCode,
                      onInput: (value) => Message.ChangedDebitAccountCode({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "debit-description",
                    label: "Debit description",
                    children: textInput(h, {
                      id: "debit-description",
                      value: model.debitDescription,
                      onInput: (value) => Message.ChangedDebitDescription({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "debit-amount",
                    label: "Debit amount (minor units)",
                    children: textInput(h, {
                      id: "debit-amount",
                      type: "number",
                      value: model.debitAmountMinor,
                      onInput: (value) => Message.ChangedDebitAmountMinor({ value }),
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "credit-account",
                    label: "Credit account code",
                    children: textInput(h, {
                      id: "credit-account",
                      value: model.creditAccountCode,
                      onInput: (value) => Message.ChangedCreditAccountCode({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "credit-description",
                    label: "Credit description",
                    children: textInput(h, {
                      id: "credit-description",
                      value: model.creditDescription,
                      onInput: (value) => Message.ChangedCreditDescription({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "credit-amount",
                    label: "Credit amount (minor units)",
                    children: textInput(h, {
                      id: "credit-amount",
                      type: "number",
                      value: model.creditAmountMinor,
                      onInput: (value) => Message.ChangedCreditAmountMinor({ value }),
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  primaryButton(h, {
                    label: model.busy ? "Working…" : "Generate export",
                    message: Option.none(),
                    type: "submit",
                    disabled: model.busy,
                  }),
                ],
              ),
            ],
          ),
          h.section(
            [h.Class("panel stack")],
            [
              h.h2([], ["Operator controls"]),
              h.p([], ["Report export polling, release, and cluster status require the admin session."]),
              field(h, {
                id: "execution-id",
                label: "Execution ID",
                children: textInput(h, {
                  id: "execution-id",
                  value: model.executionId,
                  onInput: (value) => Message.ChangedExecutionId({ value }),
                  type: "text",
                  placeholder: "",
                  autocomplete: "off",
                }),
              }),
              h.div(
                [h.Class("actions")],
                [
                  primaryButton(h, {
                    label: model.busy ? "Working…" : "Poll export",
                    message: Option.some(Message.ClickedPoll()),
                    type: "button",
                    disabled: model.busy || model.executionId.trim() === "",
                  }),
                  quietButton(h, {
                    label: "Release export",
                    message: Message.ClickedRelease(),
                    disabled: model.busy || model.executionId.trim() === "",
                  }),
                  quietButton(h, {
                    label: "Cluster status",
                    message: Message.ClickedStatus(),
                    disabled: model.busy,
                  }),
                ],
              ),
              model.artifactPath === null ? h.empty : h.p([], [`Artifact: ${model.artifactPath}`]),
              model.releasedBy === null ? h.empty : h.p([], [`Released by: ${model.releasedBy}`]),
              model.clusterStatus === null ? h.empty : h.p([], [model.clusterStatus]),
            ],
          ),
        ],
      ),
    ],
  }),
})
