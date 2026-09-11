import { Array, Effect, Equivalence, Layer, Option, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { EntitlementUnavailable, Entitlements } from "effect-domains/entitlements"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"

const PurchaseRowsSchema = Schema.Array(Schema.Struct({ status: Schema.Literals(["granted", "refunded", "revoked"]) }))
const unavailable = () => EntitlementUnavailable.make({})

const granted = (purchase: typeof PurchaseRowsSchema.Type[number]) => Equivalence.strictEqual<string>()(purchase.status, "granted")

const entitlementService = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  const has = Effect.fn("PurchasedGuides.Entitlements.has")(function* (request: Parameters<Entitlements["Service"]["has"]>[0]) {
    const supported = Equivalence.strictEqual<string>()(request.name, "guides.read")
    if (!supported) return yield* Effect.succeed(false)

    const subject = yield* pipe(
      Schema.decodeUnknownEffect(ExampleSubjectSchema)(request.subject),
      Effect.mapError(unavailable),
    )

    const rows = yield* pipe(
      database`
        SELECT status
        FROM ${database(GuidePurchasesResource.table.name)}
        WHERE tenantId = ${subject.tenantId}
          AND userId = ${subject.userId}
          AND guideId = ${request.key}
        LIMIT 1
      `,
      Effect.flatMap(Schema.decodeUnknownEffect(PurchaseRowsSchema)),
      Effect.mapError(unavailable),
    )

    return pipe(Array.head(rows), Option.exists(granted))
  })

  return Entitlements.of({ has })
})

export const PurchasedGuideEntitlements = Layer.effect(Entitlements, entitlementService)

// Insert once because restart must preserve refunds and revoked purchase grants.
export const seedPurchasedGuides = Effect.fn("PurchasedGuides.seed")(function* () {
  const database = yield* SqlClient.SqlClient

  yield* database`
    INSERT INTO ${database(GuidesResource.table.name)} (id, tenantId, title, summary, body)
    SELECT ${"guide-sql-basics"}, ${"acme"}, ${"SQL field guide"}, ${"A practical guide to safe reporting queries."}, ${"Use named columns, constrain tenant visibility, and keep purchase grants separate from report roles."}
    WHERE NOT EXISTS (SELECT 1 FROM ${database(GuidesResource.table.name)} WHERE id = ${"guide-sql-basics"})
  `

  yield* database`
    INSERT INTO ${database(GuidesResource.table.name)} (id, tenantId, title, summary, body)
    SELECT ${"guide-audit-trails"}, ${"acme"}, ${"Audit trail guide"}, ${"A paid guide with no grant for the demo reader."}, ${"This guide stays visible to the tenant policy but requires its own one-time purchase grant."}
    WHERE NOT EXISTS (SELECT 1 FROM ${database(GuidesResource.table.name)} WHERE id = ${"guide-audit-trails"})
  `

  yield* database`
    INSERT INTO ${database(GuidesResource.table.name)} (id, tenantId, title, summary, body)
    SELECT ${"guide-other-tenant"}, ${"other"}, ${"Other tenant guide"}, ${"A guide hidden from Acme subjects."}, ${"Tenant visibility is checked before the guide purchase entitlement."}
    WHERE NOT EXISTS (SELECT 1 FROM ${database(GuidesResource.table.name)} WHERE id = ${"guide-other-tenant"})
  `

  yield* database`
    INSERT INTO ${database(GuidePurchasesResource.table.name)} (id, tenantId, userId, guideId, status)
    SELECT ${"purchase-bob-sql-basics"}, ${"acme"}, ${"bob"}, ${"guide-sql-basics"}, ${"granted"}
    WHERE NOT EXISTS (SELECT 1 FROM ${database(GuidePurchasesResource.table.name)} WHERE id = ${"purchase-bob-sql-basics"})
  `
})
