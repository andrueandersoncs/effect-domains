import { identity, Schema, pipe } from "effect"
import { NonNegativeSafeIntSchema, PositiveSafeIntSchema, UuidV7Schema } from "effect-domains/domain"

export const MinorUnitsSchema = identity(NonNegativeSafeIntSchema)
export const PositiveMinorUnitsSchema = identity(PositiveSafeIntSchema)
export const QuantitySchema = identity(PositiveSafeIntSchema)
export const VersionSchema = identity(PositiveSafeIntSchema)
export const LineNumberSchema = identity(PositiveSafeIntSchema)

export const TenantIdSchema = pipe(Schema.NonEmptyString, Schema.brand("BillingTenantId"))
export const OrderNumberSchema = pipe(Schema.NonEmptyString, Schema.brand("OrderNumber"))
export const InvoiceNumberSchema = pipe(Schema.NonEmptyString, Schema.brand("InvoiceNumber"))

export const OrderStatusSchema = Schema.Literals(["draft", "invoiced"])
export const InvoiceStatusSchema = Schema.Literals(["issued", "paid"])

export const OrderSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  number: OrderNumberSchema,
  customer: Schema.NonEmptyString,
  status: OrderStatusSchema,
  totalMinor: MinorUnitsSchema,
  version: VersionSchema,
})

export interface Order extends Schema.Schema.Type<typeof OrderSchema> {}

export const OrderLineSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  orderId: Schema.String,
  lineNumber: LineNumberSchema,
  description: Schema.NonEmptyString,
  quantity: QuantitySchema,
  unitAmountMinor: PositiveMinorUnitsSchema,
})

interface OrderLine extends Schema.Schema.Type<typeof OrderLineSchema> {}

export const InvoiceSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  orderId: Schema.String,
  number: InvoiceNumberSchema,
  status: InvoiceStatusSchema,
  totalMinor: MinorUnitsSchema,
  version: VersionSchema,
})

interface Invoice extends Schema.Schema.Type<typeof InvoiceSchema> {}

export const CreateOrderInputSchema = Schema.Struct({
  number: OrderNumberSchema,
  customer: Schema.NonEmptyString,
})

interface CreateOrderInput extends Schema.Schema.Type<typeof CreateOrderInputSchema> {}

export const AddLineInputSchema = Schema.Struct({
  orderId: Schema.String,
  expectedVersion: VersionSchema,
  lineNumber: LineNumberSchema,
  description: Schema.NonEmptyString,
  quantity: QuantitySchema,
  unitAmountMinor: PositiveMinorUnitsSchema,
})

interface AddLineInput extends Schema.Schema.Type<typeof AddLineInputSchema> {}

export const IssueInvoiceInputSchema = Schema.Struct({
  orderId: Schema.String,
  expectedVersion: VersionSchema,
  number: InvoiceNumberSchema,
})

interface IssueInvoiceInput extends Schema.Schema.Type<typeof IssueInvoiceInputSchema> {}

export const PayInvoiceInputSchema = Schema.Struct({
  invoiceId: Schema.String,
  expectedVersion: VersionSchema,
})

interface PayInvoiceInput extends Schema.Schema.Type<typeof PayInvoiceInputSchema> {}

export const GetOrderInputSchema = Schema.Struct({ orderId: UuidV7Schema })

interface GetOrderInput extends Schema.Schema.Type<typeof GetOrderInputSchema> {}

export class OrderNotFound extends Schema.TaggedError<OrderNotFound>()(
  "OrderNotFound",
  { orderId: Schema.String },
) {}

export class OrderNotDraft extends Schema.TaggedError<OrderNotDraft>()(
  "OrderNotDraft",
  { orderId: Schema.String, actual: OrderStatusSchema },
) {}

export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()(
  "InvoiceNotFound",
  { invoiceId: Schema.String },
) {}

export class InvoiceRequiresLines extends Schema.TaggedError<InvoiceRequiresLines>()(
  "InvoiceRequiresLines",
  { orderId: Schema.String },
) {}

export class TotalOverflow extends Schema.TaggedError<TotalOverflow>()(
  "TotalOverflow",
  { orderId: Schema.String },
) {}

export class DuplicateOrderNumber extends Schema.TaggedError<DuplicateOrderNumber>()(
  "DuplicateOrderNumber",
  { number: OrderNumberSchema },
) {}

export class DuplicateInvoiceNumber extends Schema.TaggedError<DuplicateInvoiceNumber>()(
  "DuplicateInvoiceNumber",
  { number: InvoiceNumberSchema },
) {}

export class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  {},
) {}
