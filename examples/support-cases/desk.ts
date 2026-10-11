import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

// The desk shares the generated UI's hardening headers because an authored page must not weaken the application's browser policy.
const headers = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
})

const deskDocument = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Support desk</title>
<script src="/desk/desk.js" defer></script>
</head>
<body>
<main class="desk" data-surface="support-desk" data-state="loading">
<header class="desk-header">
<h1>Support desk</h1>
<button type="button" class="queue-toolbar__reload" data-operation="support.board">Refresh</button>
</header>
<p class="desk-outcome" role="status" data-outcome="idle"></p>
<table class="desk-board">
<thead><tr><th>Case</th><th>Subject</th><th>Customer</th><th>Status</th><th>Agent</th><th>Version</th><th>Note</th><th>Agent to assign</th><th>Actions</th></tr></thead>
<tbody class="desk-rows"></tbody>
</table>
</main>
</body>
</html>
`

// The client keeps each row's case in its own closure because the submitted command must never be read back from presentation attributes.
const deskScript = `"use strict"
;(() => {
  const transitions = {
    triage: { from: ["open"], label: "Triage" },
    assign: { from: ["triaged"], label: "Assign" },
    resolve: { from: ["assigned"], label: "Resolve" },
    reopen: { from: ["resolved"], label: "Reopen" },
  }
  const main = document.querySelector("main[data-surface='support-desk']")
  const rows = main.querySelector(".desk-rows")
  const outcome = main.querySelector("[role='status']")
  const refresh = main.querySelector(".queue-toolbar__reload")
  const state = { agents: [] }

  const call = async (operation, input) => {
    const response = await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, input }),
    })
    const body = await response.json()
    return { status: response.status, body }
  }

  const items = (reply) => reply.body && reply.body.result && Array.isArray(reply.body.result.items) ? reply.body.result.items : null

  const cell = (column, value, text) => {
    const td = document.createElement("td")
    td.className = "desk-cell"
    td.setAttribute("data-column", column)
    td.setAttribute("data-value", JSON.stringify(value))
    td.textContent = text
    return td
  }

  const allowed = (status) => Object.keys(transitions).filter((action) => transitions[action].from.includes(status))

  const settle = (kind, text) => {
    outcome.setAttribute("data-outcome", kind)
    outcome.textContent = text
    main.setAttribute("data-state", "ready")
  }

  const busy = () => {
    main.setAttribute("data-state", "busy")
    outcome.removeAttribute("data-outcome")
    outcome.textContent = ""
  }

  const agentSelect = () => {
    const select = document.createElement("select")
    select.className = "queue-item__assignee"
    select.setAttribute("aria-label", "On-duty agent")
    select.setAttribute("data-field", "assignedAgentId")
    const blank = document.createElement("option")
    blank.value = ""
    blank.textContent = "Choose an agent"
    select.append(blank)
    state.agents.filter((agent) => agent.onDuty).forEach((agent) => {
      const option = document.createElement("option")
      option.value = agent.id
      option.textContent = agent.name
      select.append(option)
    })
    return select
  }

  const advance = async (supportCase, action, note, agent) => {
    busy()
    const input = { caseId: supportCase.id, expectedVersion: supportCase.version, action }
    if (note.value !== "") input.note = note.value
    if (agent && agent.value !== "") input.assignedAgentId = agent.value
    const reply = await call("support.advanceCase", input).catch(() => null)
    const accepted = reply !== null && reply.status >= 200 && reply.status < 300
    const failure = reply && reply.body && reply.body.error ? reply.body.error._tag || reply.body.error.message || "failed" : "failed"
    await load()
    settle(accepted ? "accepted" : "refused", accepted ? transitions[action].label + " recorded for " + supportCase.subject : "Refused: " + failure)
  }

  const renderRow = (supportCase) => {
    const tr = document.createElement("tr")
    tr.className = "queue-item"
    tr.setAttribute("data-case-id", supportCase.id)
    tr.append(
      cell("id", supportCase.id, supportCase.id.slice(0, 8)),
      cell("subject", supportCase.subject, supportCase.subject),
      cell("customerName", supportCase.customerName, supportCase.customerName),
      cell("status", supportCase.status, supportCase.status),
      cell("agentName", supportCase.agentName, supportCase.agentName === null ? "Unassigned" : supportCase.agentName),
      cell("version", supportCase.version, String(supportCase.version)),
    )
    const noteCell = document.createElement("td")
    const note = document.createElement("input")
    note.type = "text"
    note.className = "queue-item__note"
    note.setAttribute("aria-label", "Note")
    note.setAttribute("data-field", "note")
    noteCell.append(note)
    const actions = allowed(supportCase.status)
    const agentCell = document.createElement("td")
    const agent = actions.includes("assign") ? agentSelect() : null
    if (agent) agentCell.append(agent)
    const actionCell = document.createElement("td")
    actions.forEach((action) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "queue-item__command queue-item__command--" + action
      button.setAttribute("data-operation", "support.advanceCase")
      button.setAttribute("data-transition", action)
      button.textContent = transitions[action].label
      button.addEventListener("click", () => { advance(supportCase, action, note, agent) })
      actionCell.append(button)
    })
    tr.append(noteCell, agentCell, actionCell)
    return tr
  }

  const load = async () => {
    const [agents, board] = await Promise.all([call("support_agents.list", {}), call("support.board", {})]).catch(() => [null, null])
    const agentItems = agents && items(agents)
    const caseItems = board && items(board)
    if (agentItems === null || caseItems === null) return false
    state.agents = agentItems
    rows.replaceChildren(...caseItems.map(renderRow))
    return true
  }

  const reload = async () => {
    busy()
    const loaded = await load()
    if (loaded) settle("loaded", "")
    else settle("failed", "The desk could not load the case board")
  }

  refresh.addEventListener("click", () => { reload() })
  reload()
})()
`

const pageResponse = HttpServerResponse.text(deskDocument, { contentType: "text/html; charset=utf-8", headers })

const scriptResponse = HttpServerResponse.text(deskScript, { contentType: "text/javascript; charset=utf-8", headers })

const page = Effect.succeed(pageResponse)

const script = Effect.succeed(scriptResponse)

const pageRoute = HttpRouter.add("GET", "/desk", page)

const scriptRoute = HttpRouter.add("GET", "/desk/desk.js", script)

/** The authored support desk: a custom triage page over the native board, agents, and advance operations, outside the generated UI. */
export const deskRoutes = Layer.mergeAll(pageRoute, scriptRoute)
