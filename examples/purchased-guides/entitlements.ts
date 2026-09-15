import { Effect, pipe } from "effect"
import { AuthorizationSubject } from "effect-domains/authorization"
import { Entitlements } from "effect-domains/entitlements"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { GuideIdSchema } from "./domain.ts"
import { GuidePurchasesResource, GuidesResource } from "./resources.ts"


const guidePurchasesTable = Resource.table(GuidePurchasesResource)
const grants = Entitlements.for(guidePurchasesTable)
const purchasedGrant = grants.eq(grants.row.status, "granted")


const purchasedGuideEntitlement = new Entitlements.Source({
  name: "guides.read",
  table: guidePurchasesTable,
  subject: ExampleSubjectSchema,
  key: "guideId",
  scope: { tenantId: "tenantId", userId: "userId" },
  grant: purchasedGrant,
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
    yield* Resource.repository(GuidesResource).ensure({
      id: sqlBasicsId,
      tenantId: "acme",
      title: "SQL field guide",
      summary: "A practical guide to safe reporting queries.",
      body: "Use named columns, constrain tenant visibility, and keep purchase grants separate from report roles.",
    })

    yield* Resource.repository(GuidesResource).ensure({
      id: auditTrailsId,
      tenantId: "acme",
      title: "Audit trail guide",
      summary: "A paid guide with no grant for the demo reader.",
      body: "This guide stays visible to the tenant policy but requires its own one-time purchase grant.",
    })

    yield* pipe(
      Resource.repository(GuidesResource).ensure({
        id: otherTenantId,
        tenantId: "other",
        title: "Other tenant guide",
        summary: "A guide hidden from Acme subjects.",
        body: "Tenant visibility is checked before the guide purchase entitlement.",
      }),
      Effect.provideService(AuthorizationSubject, otherAdministrator),
    )

    yield* Resource.repository(GuidePurchasesResource).ensure({
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
