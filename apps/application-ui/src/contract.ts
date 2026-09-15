export type ApplicationUiPresentation = Readonly<Partial<{
  title: string
  description: string
  resources: Readonly<Record<string, Readonly<Partial<{ label: string; columns: ReadonlyArray<string> }>>>>
  operations: Readonly<Record<string, Readonly<Partial<{ label: string; description: string }>>>>
}>>
