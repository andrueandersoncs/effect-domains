import { Effect, FileSystem, Path } from "effect"

export const replaceFileAtomically = Effect.fn("ExampleFiles.replaceAtomically")(function* (
  { path: destination, contents }: Readonly<{ path: string; contents: string }>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.dirname(destination)
  const prefix = `.${path.basename(destination)}.`
  yield* fileSystem.makeDirectory(directory, { recursive: true })
  const temporary = yield* fileSystem.makeTempFileScoped({ directory, prefix })
  yield* fileSystem.writeFileString(temporary, contents)
  yield* fileSystem.rename(temporary, destination)
}, Effect.scoped)
