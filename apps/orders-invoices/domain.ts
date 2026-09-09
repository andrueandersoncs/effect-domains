import { Schema, pipe } from "effect"
const atLeastZero = Schema.isGreaterThanOrEqualTo(0)
const greaterThanZero = Schema.isGreaterThan(0)
const atMostSafeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
export const TenantIdSchema = pipe(Schema.NonEmptyString, Schema.brand("BillingTenantId"))
export const OrderNumberSchema = pipe(Schema.NonEmptyString, Schema.brand("OrderNumber"))
export const InvoiceNumberSchema = pipe(Schema.NonEmptyString, Schema.brand("InvoiceNumber"))
export const MinorUnitsSchema = Schema.Int.check(atLeastZero, atMostSafeInteger)
export const PositiveMinorUnitsSchema = MinorUnitsSchema.check(greaterThanZero)
export const QuantitySchema = Schema.Int.check(greaterThanZero, atMostSafeInteger)
export const VersionSchema = Schema.Int.check(greaterThanZero, atMostSafeInteger)
export const LineNumberSchema = Schema.Int.check(greaterThanZero, atMostSafeInteger)
export const OrderStatusSchema = Schema.Literals(["draft", "invoiced"])
export const InvoiceStatusSchema = Schema.Literals(["issued", "paid"])
const VersionConflictResourceSchema = Schema.Literals(["order", "invoice"])
const InvalidOrderActionSchema = Schema.Literals(["addLine", "issueInvoice"])
const PayInvoiceActionSchema = Schema.Literal("payInvoice")

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

export interface CreateOrderInput extends Schema.Schema.Type<typeof CreateOrderInputSchema> {}

export const AddLineInputSchema = Schema.Struct({
  orderId: Schema.String,
  expectedVersion: VersionSchema,
  lineNumber: LineNumberSchema,
  description: Schema.NonEmptyString,
  quantity: QuantitySchema,
  unitAmountMinor: PositiveMinorUnitsSchema,
})

export interface AddLineInput extends Schema.Schema.Type<typeof AddLineInputSchema> {}

export const IssueInvoiceInputSchema = Schema.Struct({
  orderId: Schema.String,
  expectedVersion: VersionSchema,
  number: InvoiceNumberSchema,
})

export interface IssueInvoiceInput extends Schema.Schema.Type<typeof IssueInvoiceInputSchema> {}

export const PayInvoiceInputSchema = Schema.Struct({
  invoiceId: Schema.String,
  expectedVersion: VersionSchema,
})

export interface PayInvoiceInput extends Schema.Schema.Type<typeof PayInvoiceInputSchema> {}
export const GetOrderInputSchema = Schema.Struct({ orderId: Schema.String })
export interface GetOrderInput extends Schema.Schema.Type<typeof GetOrderInputSchema> {}

export class OrderNotFound extends Schema.TaggedError<OrderNotFound>()(
  "OrderNotFound",
  { orderId: Schema.String },
) {}

export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()(
  "InvoiceNotFound",
  { invoiceId: Schema.String },
) {}

export class VersionConflict extends Schema.TaggedError<VersionConflict>()(
  "VersionConflict",
  { resource: VersionConflictResourceSchema, id: Schema.String, expectedVersion: VersionSchema },
) {}

export class InvalidOrderTransition extends Schema.TaggedError<InvalidOrderTransition>()(
  "InvalidOrderTransition",
  { orderId: Schema.String, action: InvalidOrderActionSchema, actual: OrderStatusSchema },
) {}

export class InvalidInvoiceTransition extends Schema.TaggedError<InvalidInvoiceTransition>()(
  "InvalidInvoiceTransition",
  { invoiceId: Schema.String, action: PayInvoiceActionSchema, actual: InvoiceStatusSchema },
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
