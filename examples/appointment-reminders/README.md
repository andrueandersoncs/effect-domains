# Appointment reminders

[All examples](../README.md)

Schedule a future reminder and watch it become a durable in-application inbox notification for a recipient. The result is an `appointment_notifications` row and, shortly afterward, a JSON projection of that inbox. It is not email or SMS delivery, appointment booking, calendar synchronization, or a cancellation workflow.

## Before you start

Use Bun 1.4.0 from the repository root. This application serves a Foldkit page at `/`, so build the shared Foldkit assets before starting `serve`. It has no generated `/admin` application. Every `serve` command also publishes protected RPC at `/rpc/v1` and MCP at `/mcp`.

Use separate disposable paths for the application database, private execution store, and projection. They make the walkthrough repeatable and avoid an existing reminder ID selecting earlier state.

```bash
bun install
bun run build

RUN_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
mkdir -p "$PWD/.tmp"
export APPOINTMENT_REMINDERS_DB="$PWD/.tmp/appointment-reminders-$RUN_ID.sqlite"
export APPOINTMENT_REMINDERS_EXECUTION_DB="$PWD/.tmp/appointment-reminders-execution-$RUN_ID.sqlite"
export APPOINTMENT_REMINDERS_PROJECTION_FILE="$PWD/.tmp/appointment-reminders-$RUN_ID.notifications.json"
```

Start the server in one terminal:

```bash
PORT=3002 bun run appointment-reminders:server
```

In another terminal, configure the remote CLI with the only demo role allowed to schedule and read the inbox:

```bash
export APPOINTMENT_REMINDERS_URL=http://127.0.0.1:3002/rpc/v1
export APPOINTMENT_REMINDERS_TOKEN=admin-demo
```

## Run it

### Create a fresh future reminder

The durable entity requires UUIDv7 values for both IDs. Generate values and timestamps at the time of the run: the reminder is one minute in the future and the appointment is another hour later, so the required ordering remains valid while you copy the command.

```bash
REMINDER_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
APPOINTMENT_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
REMINDER_AT=$(bun -e 'console.log(new Date(Date.now() + 60000).toISOString())')
APPOINTMENT_AT=$(bun -e 'console.log(new Date(Date.now() + 3660000).toISOString())')
```

Submit this exact `ScheduleReminderDiscard` envelope. `entityId` routes to the recipient entity and **must** equal `payload.recipient`.

```bash
bun run appointment-reminders AppointmentRecipient.ScheduleReminderDiscard --input-json "{\"entityId\":\"alice\",\"payload\":{\"recipient\":\"alice\",\"reminderId\":\"$REMINDER_ID\",\"appointmentId\":\"$APPOINTMENT_ID\",\"appointmentAt\":\"$APPOINTMENT_AT\",\"reminderAt\":\"$REMINDER_AT\",\"location\":\"Studio A\",\"purpose\":\"Equipment handover\"}}"
```

`ScheduleReminderDiscard` confirms acceptance by the durable entity; it does **not** mean that a notification has already been delivered. Query immediately to see the current inbox page. The generated list takes a `filter` object and returns `{ "items": [...], "nextCursor": ... }`; this fresh recipient's item array is normally empty until the reminder time.

```bash
bun run appointment-reminders appointment_notifications.list --input-json '{"filter":{"recipient":"alice"}}'
```

After the reminder time, run the same list command again. It contains an item with this shape (timestamps and IDs are your generated values):

```json
{
  "id": "[\"alice\",\"uuidv7-reminder-id\"]",
  "recipient": "alice",
  "reminderId": "uuidv7-reminder-id",
  "appointmentId": "uuidv7-appointment-id",
  "appointmentAt": "...",
  "reminderAt": "...",
  "location": "Studio A",
  "purpose": "Equipment handover",
  "deliveredAt": "...",
  "archivedAt": null
}
```

This durable row is the application's delivered-notification state. The non-discard `AppointmentRecipient.ScheduleReminder` takes the same envelope but waits for delivery and returns that notification object; use it only when waiting through the scheduled time is intentional.

### Repeat safely and recognize declared failures

Repeat the same discard request unchanged. Delivery is deduplicated by the `(recipient, reminderId)`-derived notification ID: the application inserts once and returns the already persisted row rather than making a second notification. It is not a replace operation—use a new reminder UUID for changed appointment details.

Application-level validation runs when the scheduled handler executes, not when the discard operation acknowledges the message. Use **`ScheduleReminder` without `Discard`** to observe those errors. Give each check a fresh message ID and an already-due reminder time so it runs immediately rather than waiting for a future appointment:

```bash
CHECK_AT=$(bun -e 'console.log(new Date(Date.now() - 1000).toISOString())')
MISMATCH_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')
ORDERING_ID=$(bun -e 'console.log(Bun.randomUUIDv7())')

# The address and payload recipient disagree.
bun run appointment-reminders AppointmentRecipient.ScheduleReminder --input-json "{\"entityId\":\"not-alice\",\"payload\":{\"recipient\":\"alice\",\"reminderId\":\"$MISMATCH_ID\",\"appointmentId\":\"$APPOINTMENT_ID\",\"appointmentAt\":\"$APPOINTMENT_AT\",\"reminderAt\":\"$CHECK_AT\",\"location\":\"Studio A\",\"purpose\":\"Equipment handover\"}}"

# Equal timestamps violate the strict reminder-before-appointment rule.
bun run appointment-reminders AppointmentRecipient.ScheduleReminder --input-json "{\"entityId\":\"alice\",\"payload\":{\"recipient\":\"alice\",\"reminderId\":\"$ORDERING_ID\",\"appointmentId\":\"$APPOINTMENT_ID\",\"appointmentAt\":\"$CHECK_AT\",\"reminderAt\":\"$CHECK_AT\",\"location\":\"Studio A\",\"purpose\":\"Equipment handover\"}}"
```

Both calls exit nonzero without inserting a notification. The first returns `AppointmentRecipientMismatch` with `entityId` and `recipient`; the second returns `ReminderMustPrecedeAppointment` with `appointmentId`, `appointmentAt`, and `reminderAt`. A database persistence problem is represented as `AppointmentReminderDeliveryFailed` with `recipient` and `reminderId`. A discard call does not return these eventual handler failures. Empty location/purpose, non-UUIDv7 IDs, and invalid UTC timestamps instead fail RPC input validation before delivery.

## Access, web, and MCP

Both scheduling and the inbox resource use the admin-role expression. `admin-demo` may schedule and read any recipient's inbox. For `alice-demo` and the other authenticated non-admin sessions, scheduling fails with `Forbidden`; inbox lists return an empty page, and direct gets return `ResourceNotFound` because those rows are outside their visibility scope. Missing or unknown credentials fail authentication. The recipient is data, not the authenticated subject, so an admin can schedule and query Alice's inbox.

At `http://127.0.0.1:3002/`, the Foldkit page starts with `admin-demo`, generates UUIDv7 IDs, and offers an inbox reload and scheduling form. With a non-admin token its button is disabled; server authorization remains authoritative. The page displays the first list response only: it does not implement a **Load next** control even if `nextCursor` is present. The resource's configured list limit is both the default and maximum of 100 notifications.

`appointment_notifications.get` takes `{ "id": <the notification's full id string> }`. Lists support equality filters on `recipient`, `appointmentId`, and `reminderId`; use `cursor` with an unchanged filter to traverse further pages from the CLI or MCP.

For MCP, connect to `http://127.0.0.1:3002/mcp` and provide an admin bearer token on each call. Each published RPC is one MCP tool; wrap the exact payload in `{ "input": <RPC payload> }`. Successful structured tool output is `{ "result": <RPC result> }`; declared failures have `isError: true`. MCP discovery reveals contracts, not permission to access this inbox.

## Projection, retention, and recovery

A singleton rewrites `APPOINTMENT_REMINDERS_PROJECTION_FILE` every five seconds with an atomically replaced snapshot:

```json
{ "notifications": [] }
```

The `notifications` array contains every current row ordered by identifier, including delivered and archived rows with their `archivedAt` values; it is empty only before any deliveries. This is a projection, not a second inbox store. The default UTC cron expression `0 0 * * *` marks notifications whose `deliveredAt` is more than 90 days old by setting `archivedAt`. It does not delete them. Set `APPOINTMENT_REMINDERS_RETENTION_CRON` to a valid cron expression only when intentionally replacing that schedule.

Application data defaults to `data/appointment-reminders.sqlite`; the native execution store defaults to `data/appointment-reminders.execution.sqlite`; the projection defaults to `data/appointment-reminders.notifications.json`. The application and execution stores have separate transaction boundaries. Back up both databases for recovery, but do not infer a cross-database transaction, automatic outbox, or exactly-once delivery guarantee for arbitrary external systems. Inbox insertion is deduplicated in the application database; the scope of that behavior is the durable in-app row described here.

A given execution store has one native `SingleRunner`: run **either** `appointment-reminders:server` or `appointment-reminders:worker` with it, never both concurrently. To continue an accepted future reminder, the projection loop, and retention without HTTP, stop the server and start a worker with the same database and projection environment:

```bash
bun run appointment-reminders:worker
```

Start `appointment-reminders:server` again with those same paths when you need remote inbox reads. Do not point the execution and application environment variables at the same SQLite file; the shared database layer checks file identity before native execution initializes.

For source details, see the [entity contract](appointment-reminder-entity.ts), [delivery and background work](background.ts), [notification schema and errors](domain.ts), [resource policy](resources.ts), [runtime entrypoint](main.ts), and the shared [runtime reference](../../docs/reference/runtime.md#durable-execution).