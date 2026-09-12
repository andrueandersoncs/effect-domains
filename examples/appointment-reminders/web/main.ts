import { DateTime, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, shell, textInput } from "@effect-domains/example-web/html"
import { Page } from "@effect-domains/example-web/page"
import { bearer, formatRpcError } from "@effect-domains/example-web/rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { Session, SessionClient, SessionMessage, SessionModel } from "@effect-domains/example-web/session"
import { AppointmentRecipientProxy, AppointmentReminderDelivery } from "../appointment-reminder-entity.ts"
import { AppointmentInboxNotificationResource } from "../resources.ts"

const ReminderWebRpcs = AppointmentRecipientProxy.merge(AppointmentInboxNotificationResource.group)
const NotificationSchema = Schema.toType(AppointmentInboxNotificationResource.table.rowSchema)
const NotificationPageSchema = AppointmentInboxNotificationResource.contracts.list.successSchema
const hexByte = (byte: number) => byte.toString(16).padStart(2, "0")
const uuidV7 = () => { const bytes = crypto.getRandomValues(new Uint8Array(16)); const timestamp = Date.now(); bytes[0] = Math.floor(timestamp / 2 ** 40) % 256; bytes[1] = Math.floor(timestamp / 2 ** 32) % 256; bytes[2] = Math.floor(timestamp / 2 ** 24) % 256; bytes[3] = Math.floor(timestamp / 2 ** 16) % 256; bytes[4] = Math.floor(timestamp / 2 ** 8) % 256; bytes[5] = timestamp % 256; bytes[6] = (bytes[6]! & 0x0f) | 0x70; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = globalThis.Array.from(bytes, hexByte).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` }
const defaultTimes = () => ({ reminderAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), appointmentAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
const emptyForm = () => ({ recipient: "", reminderId: uuidV7(), appointmentId: uuidV7(), ...defaultTimes(), location: "", purpose: "" })

export const WebClient = RpcService.make({ name: "appointment-reminders/WebClient", group: ReminderWebRpcs })
export type WebClient = Type<typeof WebClient>

export const Model = Schema.Struct({
  session: SessionModel,
  inbox: NotificationPageSchema,
  recipient: Schema.String, reminderId: Schema.String, appointmentId: Schema.String, appointmentAt: Schema.String, reminderAt: Schema.String, location: Schema.String, purpose: Schema.String,
  requests: RequestStateSchema,
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SessionChanged: { message: SessionMessage }, ChangedRecipient: { value: Schema.String }, ChangedReminderId: { value: Schema.String }, ChangedAppointmentId: { value: Schema.String }, ChangedAppointmentAt: { value: Schema.String }, ChangedReminderAt: { value: Schema.String }, ChangedLocation: { value: Schema.String }, ChangedPurpose: { value: Schema.String }, ClickedGenerateIds: {}, ClickedReload: {}, ClickedLoadMore: {}, ClickedSchedule: {},
  SucceededList: { request: RequestTokenSchema, page: NotificationPageSchema, append: Schema.Boolean }, SucceededSchedule: { request: RequestTokenSchema }, Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>
const currentToken = (session: typeof SessionModel.Type) => Session.token(session)
const requestEffect = <A, E, Success extends Message>(request: typeof RequestTokenSchema.Type, effect: Effect.Effect<A, E, WebClient>, success: (value: A) => Success) => pipe(
  effect,
  Effect.match({ onSuccess: success, onFailure: (error) => Message.Failed({ request, error: formatRpcError(error) }) }),
)

export const ListNotifications = Command.define("ListNotifications", {
  args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String), recipient: Schema.String, cursor: Schema.NullOr(Schema.String), append: Schema.Boolean }, messages: [Message.SucceededList, Message.Failed],
  execute: ({ request, token, recipient, cursor, append }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["appointment_notifications.list"]({ filter: { recipient }, ...Page.input(cursor) }, bearer(token)))), (page) => Message.SucceededList({ request, page, append })),
})
export const ScheduleReminder = Command.define("ScheduleReminder", {
  args: { request: RequestTokenSchema, token: Schema.NullOr(Schema.String), recipient: Schema.String, reminderId: Schema.String, appointmentId: Schema.String, appointmentAt: Schema.String, reminderAt: Schema.String, location: Schema.String, purpose: Schema.String }, messages: [Message.SucceededSchedule, Message.Failed],
  execute: (args) => requestEffect(args.request, Effect.gen(function*() {
    const payload = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(AppointmentReminderDelivery))({ recipient: args.recipient.trim(), reminderId: args.reminderId.trim(), appointmentId: args.appointmentId.trim(), appointmentAt: args.appointmentAt.trim(), reminderAt: args.reminderAt.trim(), location: args.location.trim(), purpose: args.purpose.trim() })
    const client = yield* WebClient
    yield* client["AppointmentRecipient.ScheduleReminderDiscard"]({ entityId: payload.recipient, payload }, bearer(args.token))
  }), () => Message.SucceededSchedule({ request: args.request })),
})

const startList = (model: Model, cursor: string | null, append: boolean) => { const next = Requests.start(model.requests, "inbox"); return { state: next.state, command: ListNotifications({ request: next.request, token: currentToken(model.session), recipient: model.recipient.trim(), cursor, append }) } }
const pending = (model: Model, ...keys: [] | [string]) => Requests.pending(model.requests, ...keys)
const resetIdentityState = (model: Model, session: typeof SessionModel.Type): Model => ({ ...model, ...emptyForm(), session, inbox: Page.empty(), recipient: currentToken(session) === null ? "" : session.username, requests: Requests.reset(model.requests), notice: null })

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.update(model.session, message)
    const commands = Command.mapMessages(child.commands, (message) => Message.SessionChanged({ message }))
    if (Session.generation(child.model) === Session.generation(model.session)) return { model: evo(model, { session: () => child.model }), commands }
    const cleared = resetIdentityState(model, child.model)
    if (currentToken(child.model) === null) return { model: cleared, commands }
    const listed = startList(cleared, null, false)
    return { model: evo(cleared, { requests: () => listed.state }), commands: [...commands, listed.command] }
  },
  ChangedRecipient: ({ value }) => ({ model: evo(model, { recipient: () => value, inbox: () => Page.empty(), requests: (current) => Requests.invalidate(current, "inbox"), notice: () => null }) }), ChangedReminderId: ({ value }) => ({ model: evo(model, { reminderId: () => value }) }), ChangedAppointmentId: ({ value }) => ({ model: evo(model, { appointmentId: () => value }) }), ChangedAppointmentAt: ({ value }) => ({ model: evo(model, { appointmentAt: () => value }) }), ChangedReminderAt: ({ value }) => ({ model: evo(model, { reminderAt: () => value }) }), ChangedLocation: ({ value }) => ({ model: evo(model, { location: () => value }) }), ChangedPurpose: ({ value }) => ({ model: evo(model, { purpose: () => value }) }),
  ClickedGenerateIds: () => ({ model: evo(model, { reminderId: uuidV7, appointmentId: uuidV7, notice: () => null }) }),
  ClickedReload: () => { const next = startList(model, null, false); return { model: evo(model, { inbox: () => Page.empty(), requests: () => next.state, notice: () => null }), commands: [next.command] } },
  ClickedLoadMore: () => { if (model.inbox.nextCursor === null || pending(model, "inbox")) return { model }; const next = startList(model, model.inbox.nextCursor, true); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: [next.command] } },
  ClickedSchedule: () => { const next = Requests.start(model.requests, "schedule"); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: [ScheduleReminder({ request: next.request, token: currentToken(model.session), recipient: model.recipient, reminderId: model.reminderId, appointmentId: model.appointmentId, appointmentAt: model.appointmentAt, reminderAt: model.reminderAt, location: model.location, purpose: model.purpose })] } },
  SucceededList: ({ request, page, append }) => Requests.accepts(model.requests, request) ? { model: evo(model, { inbox: (current) => Page.receive(current, page, append), requests: (current) => Requests.succeed(current, request) }) } : { model },
  SucceededSchedule: ({ request }) => { if (!Requests.accepts(model.requests, request)) return { model }; const settled = evo(model, { requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: "Reminder accepted. The inbox updates after its reminder time." }) }); const next = startList(settled, null, false); return { model: evo(settled, { inbox: () => Page.empty(), requests: () => next.state }), commands: [next.command] } },
  Failed: ({ request, error }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.fail(current, request, error), notice: () => ({ kind: "error" as const, text: error }) }) } : { model },
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({ model: { session: Session.empty(), inbox: Page.empty(), ...emptyForm(), requests: Requests.empty(), notice: null } })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Appointment reminders", body: shell(h, { title: "Appointment reminders", lede: "Schedule durable in-app reminders, then check the recipient’s delivery inbox after the reminder time.", notice: model.notice, session: Session.view(h, model.session, (message) => Message.SessionChanged({ message })), children: [h.div([h.Class("split")], [
  h.section([h.Class("panel stack")], [h.div([h.Class("actions")], [h.h2([], ["Recipient inbox"]), primaryButton(h, { label: pending(model, "inbox") ? "Loading…" : "Reload inbox", message: Option.some(Message.ClickedReload()), type: "button", disabled: pending(model, "inbox") || currentToken(model.session) === null })]), dataTable(h, { caption: `Delivered reminders for ${model.recipient || "recipient"}`, columns: ["Purpose", "Appointment", "Reminder", "Location", "Delivered"], rows: model.inbox.items, key: (notification) => notification.id, cells: (notification) => [notification.purpose, DateTime.formatIso(notification.appointmentAt), DateTime.formatIso(notification.reminderAt), notification.location, DateTime.formatIso(notification.deliveredAt)] }), model.inbox.nextCursor === null ? h.empty : quietButton(h, { label: pending(model, "inbox") ? "Loading…" : "Load more", message: Message.ClickedLoadMore(), disabled: pending(model, "inbox") || currentToken(model.session) === null })]),
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSchedule())], [h.h2([], ["Schedule a reminder"]), field(h, { id: "recipient", label: "Recipient", children: textInput(h, { id: "recipient", value: model.recipient, onInput: (value) => Message.ChangedRecipient({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "reminder-id", label: "Reminder ID (UUIDv7)", children: textInput(h, { id: "reminder-id", value: model.reminderId, onInput: (value) => Message.ChangedReminderId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "appointment-id", label: "Appointment ID (UUIDv7)", children: textInput(h, { id: "appointment-id", value: model.appointmentId, onInput: (value) => Message.ChangedAppointmentId({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), quietButton(h, { label: "Generate IDs", message: Message.ClickedGenerateIds(), disabled: false }), field(h, { id: "reminder-at", label: "Reminder at (ISO 8601 UTC)", children: textInput(h, { id: "reminder-at", value: model.reminderAt, onInput: (value) => Message.ChangedReminderAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "appointment-at", label: "Appointment at (ISO 8601 UTC)", children: textInput(h, { id: "appointment-at", value: model.appointmentAt, onInput: (value) => Message.ChangedAppointmentAt({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "location", label: "Location", children: textInput(h, { id: "location", value: model.location, onInput: (value) => Message.ChangedLocation({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "purpose", label: "Purpose", children: textInput(h, { id: "purpose", value: model.purpose, onInput: (value) => Message.ChangedPurpose({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), primaryButton(h, { label: pending(model, "schedule") ? "Scheduling…" : "Schedule reminder", message: Option.none(), type: "submit", disabled: pending(model, "schedule") || currentToken(model.session) === null }) ])]),
]) ] }) })
