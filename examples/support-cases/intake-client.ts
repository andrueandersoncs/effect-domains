import { Array, Effect, Schema, pipe } from "effect"
import { Machine } from "effect-machine"
import { IntakeApi, IntakeEvent, IntakeState, intakeMachine } from "./intake-machine.ts"
import { SupportCasePrioritySchema } from "./domain.ts"

const CustomerSchema = Schema.Struct({ id: Schema.String, name: Schema.String })
const OpenedSchema = Schema.Struct({ id: Schema.String })

const call = <A>(operation: string, input: unknown, result: Schema.Schema<A>, failure: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch("/api/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, input }),
        signal,
      }),
      catch: () => failure,
    })

    if (!response.ok) return yield* Effect.fail(failure)

    const body = yield* Effect.tryPromise({ try: () => response.json(), catch: () => failure })
    const decoded = yield* pipe(
      Schema.decodeUnknownEffect(Schema.Struct({ result }))(body),
      Effect.mapError(() => failure),
    )

    return decoded.result
  })

const api = {
  customer: (id: string) => call("support_customers.get", { id }, CustomerSchema,
    "Customer not found or unavailable. Check the ID and try again."),
  open: (input: { readonly customerId: string; readonly subject: string; readonly priority: typeof SupportCasePrioritySchema.Type }) =>
    call("support.openCase", input, OpenedSchema,
      "The result is unknown. Check the case list before attempting another submission."),
}

// The route owns this static element; it is present before this module executes.
const screen = document.querySelector<HTMLElement>("#intake") as HTMLElement
const actor = await Effect.runPromise(Effect.provideService(Machine.spawn(intakeMachine), IntakeApi, api))

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const element = document.createElement(tag)

  if (text) element.textContent = text

  return element
}

const button = (text: string, kind: "submit" | "button" = "button") => {
  const element = node("button", text)

  element.type = kind

  return element
}

const back = () => {
  const control = button("Change customer")

  control.className = "secondary"
  control.addEventListener("click", () => actor.client.send(IntakeEvent.Back))

  return control
}

const field = (label: string, control: HTMLInputElement | HTMLSelectElement) => {
  const wrapper = node("label")
  const caption = node("span", label)

  wrapper.append(caption, control)

  return wrapper
}

const render = (state: typeof IntakeState.Type) => {
  const content = node("section")

  switch (state._tag) {
    case "Customer": {
      content.append(node("h2", "Find a customer"), node("p", "Enter an existing customer ID to begin."))
      const form = node("form")
      const id = node("input")

      id.name = "customerId"
      id.required = true
      id.autocomplete = "off"
      id.value = state.customerId
      form.append(field("Customer ID", id), button("Find customer", "submit"))
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        actor.client.send(IntakeEvent.Lookup({ customerId: id.value }))
      })
      content.append(form)
      if (state.message) {
        const error = node("p", state.message)

        error.className = "notice error"
        error.setAttribute("role", "alert")
        content.append(error)
      }
      break
    }
    case "LookingUp": {
      content.append(node("h2", "Finding customer"), node("p", `Looking up ${state.customerId}…`), back())
      break
    }
    case "Editing": {
      content.append(node("h2", "Describe the case"), node("p", `${state.customerName} · ${state.customerId}`))
      const form = node("form")
      const subject = node("input")
      const priority = node("select")

      subject.name = "subject"
      subject.required = true
      subject.pattern = ".*\\S.*"
      subject.title = "Enter a subject with at least one non-space character."
      subject.autocomplete = "off"
      Array.forEach(SupportCasePrioritySchema.literals, (value) => {
        const option = node("option", value[0]!.toUpperCase() + value.slice(1))

        option.value = value
        if (value === "normal") option.selected = true
        priority.append(option)
      })
      form.append(field("Subject", subject), field("Priority", priority), button("Open case", "submit"))
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        const selected = priority.value

        if (!Schema.is(SupportCasePrioritySchema)(selected)) return
        actor.client.send(IntakeEvent.Submit({ subject: subject.value, priority: selected }))
      })
      content.append(form, back())
      break
    }
    case "Submitting": {
      content.append(node("h2", "Opening case"), node("p", "Waiting for the server to save the case and its opening history…"))
      break
    }
    case "Complete": {
      content.append(node("h2", "Case opened"), node("p", "The case and opening history are saved."))
      const id = node("strong", state.caseId)

      id.className = "case-id"
      content.append(id)
      break
    }
    case "Failed": {
      content.append(node("h2", "Could not confirm the case"))
      const error = node("p", state.message)

      error.className = "notice error"
      error.setAttribute("role", "alert")
      content.append(error)
      break
    }
  }

  screen.replaceChildren(content)
}

actor.client.subscribe(render)
await Effect.runPromise(actor.start)
render(actor.client.getSnapshot())
window.addEventListener("pagehide", () => actor.client.stop(), { once: true })
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload()
})
