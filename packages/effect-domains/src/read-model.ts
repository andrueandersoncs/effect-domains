import {
  foldReadModel,
  ReadModelDescription,
  ReadModelSyntaxSchema,
  transformReadModelF,
} from "./read-model-syntax.ts"

import {
  compileReadModel,
  defineReadModel,
  describeReadModel,
  readModelSources,
} from "./read-model-compiler.ts"

import {
  commandFromPage,
  compileReadModelPage,
  pageReadModel,
} from "./read-model-page.ts"

export const ReadModel = {
  Schema: ReadModelSyntaxSchema,
  describe: describeReadModel,
  sources: readModelSources,
  define: defineReadModel,
  page: pageReadModel,
  compile: compileReadModel,
  compilePage: compileReadModelPage,
  publish: commandFromPage,
  fold: foldReadModel,
  map: transformReadModelF,
  DescriptionSchema: ReadModelDescription,
}
