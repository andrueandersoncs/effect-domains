import { Schema } from "effect"

const minimumRating = Schema.isGreaterThanOrEqualTo(1)
const maximumRating = Schema.isLessThanOrEqualTo(5)

export const ReadingStatusSchema = Schema.Literals([
  "planned",
  "reading",
  "finished",
])

export const BookFormatSchema = Schema.Literals([
  "paperback",
  "hardcover",
  "ebook",
  "audiobook",
])

export const RatingSchema = Schema.Int.check(minimumRating, maximumRating)

export const ReadingListBookSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  author: Schema.NonEmptyString,
  status: ReadingStatusSchema,
  format: BookFormatSchema,
  rating: Schema.NullOr(RatingSchema),
  notes: Schema.NullOr(Schema.NonEmptyString),
})

