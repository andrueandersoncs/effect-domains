import { Context, Effect, Schema } from "effect"
import { Event, Machine, State } from "effect-machine"
import { SupportCasePrioritySchema } from "./domain.ts"

export class IntakeApi extends Context.Service<IntakeApi, {
  readonly customer: (id: string) => Effect.Effect<{ readonly id: string; readonly name: string }, string>
  readonly open: (input: { readonly customerId: string; readonly subject: string; readonly priority: typeof SupportCasePrioritySchema.Type }) => Effect.Effect<{ readonly id: string }, string>
}>()("support-cases/IntakeApi") {}

export const IntakeState = State({
  Customer: { customerId: Schema.String, message: Schema.optionalKey(Schema.String) },
  LookingUp: { customerId: Schema.String },
  Editing: { customerId: Schema.String, customerName: Schema.String },
  Submitting: { customerId: Schema.String, customerName: Schema.String, subject: Schema.String, priority: SupportCasePrioritySchema },
  Complete: { caseId: Schema.String },
  Failed: { message: Schema.String },
})

export const IntakeEvent = Event({
  Lookup: { customerId: Schema.String },
  Back: {},
  Found: { customerId: Schema.String, customerName: Schema.String },
  LookupFailed: { message: Schema.String },
  Submit: { subject: Schema.String, priority: SupportCasePrioritySchema },
  Opened: { caseId: Schema.String },
  OpenFailed: { message: Schema.String },
})

export const intakeMachine = Machine.make({
  state: IntakeState,
  event: IntakeEvent,
  initial: () => IntakeState.Customer({ customerId: "" }),
})
  .on(IntakeState.Customer, IntakeEvent.Lookup, ({ event }) => {
    const customerId = event.customerId.trim()

    return customerId
      ? IntakeState.LookingUp({ customerId })
      : IntakeState.Customer({ customerId: event.customerId, message: "Enter a customer ID." })
  })
  .task(IntakeState.LookingUp, ({ state }) =>
    Effect.flatMap(IntakeApi, (api) => api.customer(state.customerId)), {
    name: "customer-lookup",
    onSuccess: (customer) => IntakeEvent.Found({ customerId: customer.id, customerName: customer.name }),
    onFailure: (message) => IntakeEvent.LookupFailed({ message }),
  })
  .on(IntakeState.LookingUp, IntakeEvent.Found, ({ event }) =>
    IntakeState.Editing({ customerId: event.customerId, customerName: event.customerName }),
  )
  .on(IntakeState.LookingUp, IntakeEvent.LookupFailed, ({ event, state }) =>
    IntakeState.Customer({ customerId: state.customerId, message: event.message }),
  )
  .on(IntakeState.LookingUp, IntakeEvent.Back, ({ state }) => IntakeState.Customer({ customerId: state.customerId }))
  .on(IntakeState.Editing, IntakeEvent.Back, ({ state }) => IntakeState.Customer({ customerId: state.customerId }))
  .on(IntakeState.Editing, IntakeEvent.Submit, ({ event, state }) => {
    const subject = event.subject.trim()

    return subject
      ? IntakeState.Submitting({ ...state, subject, priority: event.priority })
      : state
  })
  .task(IntakeState.Submitting, ({ state }) =>
    Effect.flatMap(IntakeApi, (api) => api.open({
      customerId: state.customerId,
      subject: state.subject,
      priority: state.priority,
    })), {
    name: "open-case",
    onSuccess: (opened) => IntakeEvent.Opened({ caseId: opened.id }),
    onFailure: (message) => IntakeEvent.OpenFailed({ message }),
  })
  .on(IntakeState.Submitting, IntakeEvent.Opened, ({ event }) =>
    IntakeState.Complete({ caseId: event.caseId }),
  )
  .on(IntakeState.Submitting, IntakeEvent.OpenFailed, ({ event }) =>
    IntakeState.Failed({ message: event.message }),
  )
  .final(IntakeState.Complete, ({ state }) => state.caseId)
  .final(IntakeState.Failed, () => undefined)
