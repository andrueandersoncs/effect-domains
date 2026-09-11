import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  dataTable,
  field,
  primaryButton,
  quietButton,
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"

const NotificationSchema = Schema.Struct({
  id: Schema.String,
  recipient: Schema.String,
  reminderId: Schema.String,
  appointmentId: Schema.String,
  appointmentAt: Schema.String,
  reminderAt: Schema.String,
  location: Schema.String,
  purpose: Schema.String,
  deliveredAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
})

const NotificationPageSchema = Schema.Struct({
  items: Schema.Array(NotificationSchema),
  nextCursor: Schema.Unknown,
})

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0")

const uuidV7 = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const timestamp = Date.now()
  bytes[0] = Math.floor(timestamp / 2 ** 40) % 256
  bytes[1] = Math.floor(timestamp / 2 ** 32) % 256
  bytes[2] = Math.floor(timestamp / 2 ** 24) % 256
  bytes[3] = Math.floor(timestamp / 2 ** 16) % 256
  bytes[4] = Math.floor(timestamp / 2 ** 8) % 256
  bytes[5] = timestamp % 256
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.join(Array.map([
    bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!,
    bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!, bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!,
  ], hexByte), "")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const defaultTimes = () => ({
  reminderAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  appointmentAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
})

const emptyForm = () => ({
  recipient: "alice",
  reminderId: uuidV7(),
  appointmentId: uuidV7(),
  ...defaultTimes(),
  location: "",
  purpose: "",
})

export const Model = Schema.Struct({
  notifications: Schema.Array(NotificationSchema),
  token: Schema.String,
  recipient: Schema.String,
  reminderId: Schema.String,
  appointmentId: Schema.String,
  appointmentAt: Schema.String,
  reminderAt: Schema.String,
  location: Schema.String,
  purpose: Schema.String,
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
  ChangedRecipient: { value: Schema.String },
  ChangedReminderId: { value: Schema.String },
  ChangedAppointmentId: { value: Schema.String },
  ChangedAppointmentAt: { value: Schema.String },
  ChangedReminderAt: { value: Schema.String },
  ChangedLocation: { value: Schema.String },
  ChangedPurpose: { value: Schema.String },
  ClickedGenerateIds: {},
  ClickedReload: {},
  ClickedSchedule: {},
  SucceededList: { notifications: Schema.Array(NotificationSchema) },
  SucceededSchedule: {},
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

export const ListNotifications = Command.define("ListNotifications", {
  args: { token: Schema.String, recipient: Schema.String },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ token, recipient }) => pipe(
    rpcCall({
      tag: "appointment_notifications.list",
      payload: { filter: { recipient } },
      token,
      success: NotificationPageSchema,
    }),
    Effect.match({
      onSuccess: (page) => Message.SucceededList({ notifications: page.items }),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }),
  ),
})

export const ScheduleReminder = Command.define("ScheduleReminder", {
  args: {
    token: Schema.String,
    recipient: Schema.String,
    reminderId: Schema.String,
    appointmentId: Schema.String,
    appointmentAt: Schema.String,
    reminderAt: Schema.String,
    location: Schema.String,
    purpose: Schema.String,
  },
  messages: [Message.SucceededSchedule, Message.Failed],
  execute: ({ token, recipient, reminderId, appointmentId, appointmentAt, reminderAt, location, purpose }) => pipe(
    rpcCall({
      tag: "AppointmentRecipient.ScheduleReminderDiscard",
      payload: {
        entityId: recipient,
        payload: {
          recipient,
          reminderId,
          appointmentId,
          appointmentAt,
          reminderAt,
          location,
          purpose,
        },
      },
      token,
      success: Schema.Unknown,
    }),
    Effect.match({
      onSuccess: () => Message.SucceededSchedule(),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }),
  ),
})

const listNotifications = (model: Model) => ListNotifications({
  token: model.token,
  recipient: model.recipient,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedToken: ({ value }) => ({ model: evo(model, { token: () => value }) }),
    SelectedToken: ({ token }) => {
      const next = evo(model, { token: () => token, busy: () => true, notice: () => null })
      return { model: next, commands: [listNotifications(next)] }
    },
    ChangedRecipient: ({ value }) => ({ model: evo(model, { recipient: () => value }) }),
    ChangedReminderId: ({ value }) => ({ model: evo(model, { reminderId: () => value }) }),
    ChangedAppointmentId: ({ value }) => ({ model: evo(model, { appointmentId: () => value }) }),
    ChangedAppointmentAt: ({ value }) => ({ model: evo(model, { appointmentAt: () => value }) }),
    ChangedReminderAt: ({ value }) => ({ model: evo(model, { reminderAt: () => value }) }),
    ChangedLocation: ({ value }) => ({ model: evo(model, { location: () => value }) }),
    ChangedPurpose: ({ value }) => ({ model: evo(model, { purpose: () => value }) }),
    ClickedGenerateIds: () => ({
      model: evo(model, { reminderId: uuidV7, appointmentId: uuidV7, notice: () => null }),
    }),
    ClickedReload: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [listNotifications(model)],
    }),
    ClickedSchedule: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [ScheduleReminder({
        token: model.token,
        recipient: model.recipient,
        reminderId: model.reminderId,
        appointmentId: model.appointmentId,
        appointmentAt: model.appointmentAt,
        reminderAt: model.reminderAt,
        location: model.location,
        purpose: model.purpose,
      })],
    }),
    SucceededList: ({ notifications }) => ({
      model: evo(model, { notifications: () => notifications, busy: () => false }),
    }),
    SucceededSchedule: () => {
      const next = evo(model, {
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: "Reminder accepted. The inbox updates after its reminder time." }),
      })
      return { model: next, commands: [listNotifications(next)] }
    },
    Failed: ({ error }) => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => {
  const form = emptyForm()
  const model: Model = {
    notifications: [],
    token: "admin-demo",
    ...form,
    busy: true,
    notice: null,
  }

  return { model, commands: [listNotifications(model)] }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Appointment reminders",
  body: shell(h, {
    title: "Appointment reminders",
    lede: "Schedule durable in-app reminders, then check the recipient’s delivery inbox after the reminder time.",
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
            [h.Class("panel stack")],
            [
              h.div(
                [h.Class("actions")],
                [
                  h.h2([], ["Recipient inbox"]),
                  primaryButton(h, {
                    label: model.busy ? "Loading…" : "Reload inbox",
                    message: Option.some(Message.ClickedReload()),
                    type: "button",
                    disabled: model.busy,
                  }),
                ],
              ),
              dataTable(h, {
                caption: `Delivered reminders for ${model.recipient || "recipient"}`,
                columns: ["Purpose", "Appointment", "Reminder", "Location", "Delivered"],
                rows: model.notifications,
                key: (notification) => notification.id,
                cells: (notification) => [
                  notification.purpose,
                  notification.appointmentAt,
                  notification.reminderAt,
                  notification.location,
                  notification.deliveredAt,
                ],
              }),
            ],
          ),
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedSchedule())],
                [
                  h.h2([], ["Schedule a reminder"]),
                  h.p([], [model.token === "admin-demo"
                    ? "The admin session can schedule and read this inbox."
                    : "Editors and other demo sessions cannot schedule or read the admin-only inbox."]),
                  field(h, {
                    id: "recipient",
                    label: "Recipient",
                    children: textInput(h, {
                      id: "recipient",
                      value: model.recipient,
                      onInput: (value) => Message.ChangedRecipient({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "reminder-id",
                    label: "Reminder ID (UUIDv7)",
                    children: textInput(h, {
                      id: "reminder-id",
                      value: model.reminderId,
                      onInput: (value) => Message.ChangedReminderId({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "appointment-id",
                    label: "Appointment ID (UUIDv7)",
                    children: textInput(h, {
                      id: "appointment-id",
                      value: model.appointmentId,
                      onInput: (value) => Message.ChangedAppointmentId({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  quietButton(h, { label: "Generate IDs", message: Message.ClickedGenerateIds(), disabled: false }),
                  field(h, {
                    id: "reminder-at",
                    label: "Reminder at (ISO 8601 UTC)",
                    children: textInput(h, {
                      id: "reminder-at",
                      value: model.reminderAt,
                      onInput: (value) => Message.ChangedReminderAt({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "appointment-at",
                    label: "Appointment at (ISO 8601 UTC)",
                    children: textInput(h, {
                      id: "appointment-at",
                      value: model.appointmentAt,
                      onInput: (value) => Message.ChangedAppointmentAt({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "location",
                    label: "Location",
                    children: textInput(h, {
                      id: "location",
                      value: model.location,
                      onInput: (value) => Message.ChangedLocation({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "purpose",
                    label: "Purpose",
                    children: textInput(h, {
                      id: "purpose",
                      value: model.purpose,
                      onInput: (value) => Message.ChangedPurpose({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  primaryButton(h, {
                    label: "Schedule reminder",
                    message: Option.none(),
                    type: "submit",
                    disabled: model.busy || model.token !== "admin-demo",
                  }),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  }),
})
