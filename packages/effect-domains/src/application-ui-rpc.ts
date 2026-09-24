import { Effect, Function, HashMap, Option, Result, Schema } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { type Invocation, requestHandlerFor } from "./application-ui-request.ts"

import {
  applicationUiDeclaredErrorResponse,
  applicationUiFailureResponse,
  applicationUiInternalResponse,
  applicationUiSuccessResponse,
} from "./application-ui-response.ts"

import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"
import { inProcessClient, type UnaryRpc } from "./rpc-in-process.ts"

export class ApplicationUiDefinitionError extends Schema.TaggedError<ApplicationUiDefinitionError>()(
  "ApplicationUiDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const maximumUiOperations = 1_000


const internalResponse = Effect.succeed(applicationUiInternalResponse)
const recoverResponseEncodingFailure = Function.constant(internalResponse)

// SAFETY: The group can be narrowed because Application compilation rejects every streaming operation.
const asUnaryGroup = (group: ApplicationIR["group"]) => group as RpcGroup.RpcGroup<UnaryRpc>

// SAFETY: The procedure can be narrowed because callers invoke this only after compileUnaryRpc returns a unary contract.
const asUnaryProcedure = (procedure: RpcProcedure) => procedure as UnaryRpc


const compileOperationInvocations = Effect.fn("ApplicationUi.operationInvocations")(function* (
  application: ApplicationIR,
) {

  if (application.group.requests.size > maximumUiOperations) {
    return yield* ApplicationUiDefinitionError.make({
      reason: `Application UI supports at most ${maximumUiOperations} operations`,
    })
  }

  const unaryGroup = asUnaryGroup(application.group)
  const { client, withHandlerContext } = yield* inProcessClient(unaryGroup)

  const compileOperation = Effect.fn("ApplicationUi.compileOperation")(function* (procedure: RpcProcedure) {
    const compiled = compileUnaryRpc(procedure)

    const contract = yield* Effect.fromOption(
      compiled,
      () => ApplicationUiDefinitionError.make({
        reason: `Application UI operations must be unary: ${procedure._tag}`,
      }),
    )

    class OperationResult extends Schema.Class<OperationResult>("OperationResult")({
      result: contract.successSchema,
    }) {}

    class OperationErrorEnvelope extends Schema.Class<OperationErrorEnvelope>("OperationErrorEnvelope")({
      error: contract.errorSchema,
    }) {}

    const decode = Schema.decodeUnknownEffect(contract.payloadSchema)
    const encodeResult = Schema.encodeUnknownEffect(OperationResult)
    const encodeError = Schema.encodeUnknownEffect(OperationErrorEnvelope)
    const unaryProcedure = asUnaryProcedure(procedure)
    const withCodecContext = withHandlerContext(unaryProcedure)

    const respondToDeclaredFailure = Effect.fn("ApplicationUi.respondToDeclaredFailure")(function* (error: unknown) {
      const envelope = OperationErrorEnvelope.make({ error })
      const encodedEnvelope = encodeError(envelope)
      const encoded = yield* withCodecContext(encodedEnvelope)

      return yield* applicationUiDeclaredErrorResponse(encoded)
    })

    const respondToDeclaredSuccess = Effect.fn("ApplicationUi.respondToDeclaredSuccess")(function* (result: unknown) {
      const envelope = OperationResult.make({ result })
      const encodedEnvelope = encodeResult(envelope)
      const encoded = yield* withCodecContext(encodedEnvelope)

      return yield* applicationUiSuccessResponse(encoded)
    })

    const execute: Invocation = Effect.fn("ApplicationUi.execute")(function* (
      input: unknown,
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const decodedInput = decode(input)
      const contextualInput = withCodecContext(decodedInput)
      const decoded = yield* Effect.result(contextualInput)

      if (Result.isFailure(decoded)) {
        return yield* applicationUiFailureResponse(
          400,
          `Invalid input for ${contract._tag}: ${decoded.failure.message}`,
        )
      }

      const call = client(contract._tag, decoded.success, { headers: request.headers })

      return yield* Effect.matchEffect(call, {
        onFailure: respondToDeclaredFailure,
        onSuccess: respondToDeclaredSuccess,
      })
    }, Effect.catchCause(recoverResponseEncodingFailure))

    return [contract._tag, execute] as const
  })

  const procedures = application.group.requests.values()
  const entries = yield* Effect.forEach(procedures, compileOperation, { concurrency: 16 })

  return HashMap.fromIterable(entries)
})

export const compileApplicationCall = Effect.fn("ApplicationUi.applicationCall")(function* (
  application: ApplicationIR,
  allowedOrigins: Option.Option<ReadonlyArray<string>>,
) {
  const invocations = yield* compileOperationInvocations(application)

  return requestHandlerFor(invocations, allowedOrigins)
})
