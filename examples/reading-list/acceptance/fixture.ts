import { Effect, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcceptanceError, PayloadSchema, type Payload, type Scenario } from "./model.ts"

const EnvelopeSchema = Schema.Struct({ result: PayloadSchema })
export const fixtureRevision = "isolated-reading-list@1"

export const prepareFixture = Effect.fn("Acceptance.prepareFixture")(function* (scenario: Scenario, artifacts: string) {
  const owned = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), "reading-list-acceptance-"))
        const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
        const port = reserved.port
        reserved.stop(true)
        const url = `http://127.0.0.1:${port}`
        const child = Bun.spawn([process.execPath, "run", "examples/reading-list/main.ts", "serve"], {
          cwd: new URL("../../../", import.meta.url).pathname,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: String(port), READING_LIST_DB: join(directory, "application.sqlite") },
          stdout: Bun.file(join(artifacts, "server.stdout.log")), stderr: Bun.file(join(artifacts, "server.stderr.log")),
        })
        return { directory, child, url }
      },
      catch: (error) => new AcceptanceError({ boundary: "fixture", message: String(error) }),
    }),
    (owned) => Effect.promise(async () => {
      owned.child.kill()
      await owned.child.exited
      await rm(owned.directory, { recursive: true, force: true })
    }),
  )
  yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = performance.now() + 20_000
      while (performance.now() < deadline) {
        if (owned.child.exitCode !== null) throw new AcceptanceError({ boundary: "runtime", message: `Application exited with ${owned.child.exitCode}; inspect server.stderr.log` })
        try {
          const response = await fetch(`${owned.url}/api`, { signal })
          if (response.ok) {
            const metadata = await response.json()
            const application = Schema.decodeUnknownSync(Schema.Struct({ application: Schema.Literal("reading-list") }))(metadata)
            return application
          }
        } catch (error) {
          if (signal.aborted) throw error
        }
        await Bun.sleep(100)
      }
      throw new AcceptanceError({ boundary: "runtime", message: "Application did not become ready within 20 seconds" })
    },
    catch: (error) => new AcceptanceError({ boundary: "fixture", message: String(error) }),
  })
  const create = Effect.fn("Acceptance.fixtureCreate")(function* (input: Payload) {
    const envelope = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${owned.url}/api/call`, { method: "POST", signal, headers: { "Content-Type": "application/json", Origin: owned.url }, body: JSON.stringify({ operation: "books.create", input }) })
        if (!response.ok) throw new AcceptanceError({ boundary: "runtime", message: `Fixture books.create HTTP ${response.status}` })
        return response.json()
      },
      catch: (error) => new AcceptanceError({ boundary: "fixture", message: String(error) }),
    })
    const decoded = yield* Schema.decodeUnknownEffect(EnvelopeSchema)(envelope).pipe(Effect.mapError((error) => new AcceptanceError({ boundary: "fixture", message: String(error) })))
    return decoded.result
  })
  const sentinel = yield* create({ title: "Unrelated fixture — preserve me", author: "Fixture author", status: "reading", format: "hardcover", rating: 4, notes: "Sentinel revision 1" })
  const target = scenario.operation === "books.update"
    ? yield* create({ title: "Target fixture — planned book", author: "Target author", status: "planned", format: "ebook", rating: 3, notes: "Keep this note" })
    : undefined
  return { url: owned.url, sentinel, target, actor: "public-reader", revision: fixtureRevision }
})
