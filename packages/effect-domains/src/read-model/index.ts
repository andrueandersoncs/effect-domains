import {
  foldReadModel,
  ReadModelDescription,
  ReadModelSyntaxSchema,
  transformReadModelF,
} from "./syntax.ts"

import {
  compileReadModel,
  defineReadModel,
  describeReadModel,
  readModelSources,
} from "./compiler.ts"

import {
  commandFromPage,
  compileReadModelPage,
  pageReadModel,
} from "./page.ts"

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
