import { Effect, Equivalence, Record, Schema, pipe } from "effect"
import { AuthorizationSubject } from "effect-domains/authorization"
import { Entitlements } from "effect-domains/entitlements"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { GuideIdSchema, GuidePurchaseSchema } from "./domain.ts"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"

const statusEquals = Equivalence.strictEqual<string>()

const entitlementWhere = (subject: Schema.Schema.Type<typeof ExampleSubjectSchema>) =>
  Record.fromEntries([["tenantId", subject.tenantId], ["userId", subject.userId]])

const entitlementGrant = (purchase: Schema.Schema.Type<typeof GuidePurchaseSchema>) =>
  statusEquals(purchase.status, "granted")

const purchasedGuideEntitlement = new Entitlements.Source({
  name: "guides.read",
  table: GuidePurchasesResource.table,
  subject: ExampleSubjectSchema,
  key: "guideId",
  where: entitlementWhere,
  grant: entitlementGrant,
})

export const PurchasedGuideEntitlements = Entitlements.fromTable(purchasedGuideEntitlement)

const administrator = ExampleSubjectSchema.make({
  userId: "admin",
  tenantId: "acme",
  roles: ["admin"],
})

const otherAdministrator = ExampleSubjectSchema.make({
  userId: "admin",
  tenantId: "other",
  roles: ["admin"],
})

const sqlBasicsId = GuideIdSchema.make("guide-sql-basics")
const auditTrailsId = GuideIdSchema.make("guide-audit-trails")

const seedEntitlements = Entitlements.of({ has: () => Effect.succeed(true) })
const otherTenantId = GuideIdSchema.make("guide-other-tenant")

// Insert once because restart must preserve refunds and revoked purchase grants.
export const seedPurchasedGuides = () => pipe(
  Effect.gen(function* () {
    yield* GuidesResource.repository.ensure({
      id: sqlBasicsId,
      tenantId: "acme",
      title: "SQL field guide",
      summary: "A practical guide to safe reporting queries.",
      body: "Use named columns, constrain tenant visibility, and keep purchase grants separate from report roles.",
    })

    yield* GuidesResource.repository.ensure({
      id: auditTrailsId,
      tenantId: "acme",
      title: "Audit trail guide",
      summary: "A paid guide with no grant for the demo reader.",
      body: "This guide stays visible to the tenant policy but requires its own one-time purchase grant.",
    })

    yield* pipe(
      GuidesResource.repository.ensure({
        id: otherTenantId,
        tenantId: "other",
        title: "Other tenant guide",
        summary: "A guide hidden from Acme subjects.",
        body: "Tenant visibility is checked before the guide purchase entitlement.",
      }),
      Effect.provideService(AuthorizationSubject, otherAdministrator),
    )

    yield* GuidePurchasesResource.repository.ensure({
      id: "purchase-bob-sql-basics",
      tenantId: "acme",
      userId: "bob",
      guideId: sqlBasicsId,
      status: "granted",
    })
  }),
  Effect.provideService(Entitlements, seedEntitlements),
  Effect.provideService(AuthorizationSubject, administrator),
)
