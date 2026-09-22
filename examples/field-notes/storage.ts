import { Buffer } from "node:buffer"
import { Config, Context, Effect, Equivalence, Layer, Option, Schema, SchemaAST, SchemaGetter, SchemaIssue, Struct, pipe } from "effect"
import { FieldReportSchema } from "./domain.ts"

const EnvelopeVersion = "v1"
const IvLength = 12
const AuthenticationTagLength = 16
const KeyLength = 32
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

class FieldNoteEncryption extends Context.Service<FieldNoteEncryption, { readonly key: CryptoKey }>()("examples/field-notes/FieldNoteEncryption") {}

class FieldNoteEncryptionKeyError extends Schema.TaggedError<FieldNoteEncryptionKeyError>()(
  "FieldNoteEncryptionKeyError",
  { reason: Schema.String },
) {}

const fieldNoteEncryption = Effect.fn("FieldNoteEncryption.make")(function* (encodedKey: string) {
  const material = Buffer.from(encodedKey, "base64url")
  const canonical = material.toString("base64url")
  const validEncoding = Equivalence.strictEqual<string>()(canonical, encodedKey)
  const wrongEncoding = !validEncoding
  const wrongLength = material.byteLength !== KeyLength
  const invalidKey = wrongLength || wrongEncoding

  if (invalidKey) {
    return yield* FieldNoteEncryptionKeyError.make({
      reason: "FIELD_NOTES_ENCRYPTION_KEY must be an unpadded Base64URL encoding of exactly 32 bytes for AES-256-GCM",
    })
  }

  const key = yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: () => FieldNoteEncryptionKeyError.make({ reason: "could not import FIELD_NOTES_ENCRYPTION_KEY" }),
  })

  return { key }
})

const encryptionKey = Config.string("FIELD_NOTES_ENCRYPTION_KEY")
const configuredEncryption = Effect.flatMap(encryptionKey, fieldNoteEncryption)

export const FieldNoteEncryptionLive = Layer.effect(FieldNoteEncryption, configuredEncryption)

export const fieldNoteEncryptionLayer = (encodedKey: string) => {
  const encryption = fieldNoteEncryption(encodedKey)

  return Layer.effect(FieldNoteEncryption, encryption)
}

const invalidStoredBody = (value: string, options: SchemaAST.ParseOptions, expected: string) =>
  new SchemaIssue.InvalidValue({ expected }, value, options)

const decodePart = Effect.fn("StoredFieldReportBody.decodePart")(function* (
  encoded: string,
  envelope: string,
  options: SchemaAST.ParseOptions,
) {
  const decoded = Buffer.from(encoded, "base64url")
  const canonical = decoded.toString("base64url")
  const validEncoding = Equivalence.strictEqual<string>()(canonical, encoded)

  if (!validEncoding) {
    const issue = invalidStoredBody(envelope, options, "a canonical Base64URL AES-GCM envelope")

    return yield* Effect.fail(issue)
  }

  return decoded
})

const decodeStoredBody = SchemaGetter.transformOrFail<string, string, FieldNoteEncryption>(
  Effect.fn("StoredFieldReportBody.decode")(function* (value, options) {
    const [version, rawIv, rawCiphertext, ...extra] = value.split(".")
    const encodedIv = Option.fromNullishOr(rawIv)
    const encodedCiphertext = Option.fromNullishOr(rawCiphertext)
    const wrongVersion = version !== EnvelopeVersion
    const extraParts = extra.length > 0
    const invalidVersion = wrongVersion || extraParts
    const missingParts = Option.isNone(encodedIv) || Option.isNone(encodedCiphertext)
    const invalidEnvelope = invalidVersion || missingParts

    if (invalidEnvelope) {
      const issue = invalidStoredBody(value, options, "a versioned AES-GCM field-report envelope")

      return yield* Effect.fail(issue)
    }

    const ivPart = Option.getOrThrow(encodedIv)
    const ciphertextPart = Option.getOrThrow(encodedCiphertext)
    const iv = yield* decodePart(ivPart, value, options)
    const ciphertext = yield* decodePart(ciphertextPart, value, options)
    const invalidIvLength = iv.byteLength !== IvLength
    const shortCiphertext = ciphertext.byteLength < AuthenticationTagLength
    const invalidLengths = invalidIvLength || shortCiphertext

    if (invalidLengths) {
      const issue = invalidStoredBody(value, options, "an AES-GCM envelope with a 96-bit nonce and authentication tag")

      return yield* Effect.fail(issue)
    }

    const encryption = yield* FieldNoteEncryption

    const plaintext = yield* Effect.tryPromise({
      try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryption.key, ciphertext),
      catch: () => invalidStoredBody(value, options, "a field-report body encrypted with the configured AES-GCM key"),
    })

    const encoded = yield* Effect.try({
      try: () => decoder.decode(plaintext),
      catch: () => invalidStoredBody(value, options, "valid UTF-8 field-report text"),
    })

    const decoded = yield* Effect.try({
      try: () => JSON.parse(encoded),
      catch: () => invalidStoredBody(value, options, "a JSON-encoded field-report body"),
    })

    return yield* pipe(
      Schema.decodeUnknownEffect(Schema.String)(decoded),
      Effect.mapError(() => invalidStoredBody(value, options, "a JSON string field-report body")),
    )
  }),
)

const encodeStoredBody = SchemaGetter.transformOrFail<string, string, FieldNoteEncryption>(
  Effect.fn("StoredFieldReportBody.encode")(function* (value, options) {
    const nonce = new Uint8Array(IvLength)

    const iv = yield* Effect.try({
      try: () => crypto.getRandomValues(nonce),
      catch: () => invalidStoredBody(value, options, "a generated AES-GCM nonce"),
    })

    const encryption = yield* FieldNoteEncryption
    const json = JSON.stringify(value)
    const plaintext = encoder.encode(json)

    const ciphertext = yield* Effect.tryPromise({
      try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryption.key, plaintext),
      catch: () => invalidStoredBody(value, options, "a field-report body encryptable with the configured AES-GCM key"),
    })

    const encodedIv = Buffer.from(iv.buffer).toString("base64url")
    const encodedCiphertext = Buffer.from(ciphertext).toString("base64url")

    return `${EnvelopeVersion}.${encodedIv}.${encodedCiphertext}`
  }),
)

export const StoredFieldReportBodySchema = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, { decode: decodeStoredBody, encode: encodeStoredBody }),
)

export const StoredFieldReportSchema = FieldReportSchema.mapFields(Struct.assign({ body: StoredFieldReportBodySchema }))

interface StoredFieldReport extends Schema.Schema.Type<typeof StoredFieldReportSchema> {}
