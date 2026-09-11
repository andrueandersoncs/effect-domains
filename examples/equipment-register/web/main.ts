import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  dataTable,
  field,
  primaryButton,
  quietButton,
  selectInput,
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"
import { AssetConditionSchema, AssetSchema } from "../domain.ts"

const AssetRowSchema = Schema.Struct({
  ...AssetSchema.fields,
  id: Schema.String,
})

const AssetPageSchema = Schema.Struct({
  items: Schema.Array(AssetRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
})

const conditions = ["in-service", "needs-repair", "retired"] as const
const conditionChoices = [
  { value: "", label: "Any condition" },
  ...Array.map(conditions, (condition) => ({ value: condition, label: condition })),
]
const formConditionChoices = Array.map(conditions, (condition) => ({ value: condition, label: condition }))

export const Model = Schema.Struct({
  assets: Schema.Array(AssetRowSchema),
  filterAssetTag: Schema.String,
  filterLocation: Schema.String,
  filterCondition: Schema.String,
  assetTag: Schema.String,
  name: Schema.String,
  model: Schema.String,
  serial: Schema.String,
  location: Schema.String,
  condition: AssetConditionSchema,
  selectedId: Schema.NullOr(Schema.String),
  listing: Schema.Boolean,
  saving: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedFilterAssetTag: { value: Schema.String },
  ChangedFilterLocation: { value: Schema.String },
  ChangedFilterCondition: { value: Schema.String },
  ChangedAssetTag: { value: Schema.String },
  ChangedName: { value: Schema.String },
  ChangedModel: { value: Schema.String },
  ChangedSerial: { value: Schema.String },
  ChangedLocation: { value: Schema.String },
  ChangedCondition: { value: Schema.String },
  ClickedReload: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { items: Schema.Array(AssetRowSchema) },
  SucceededSave: { asset: AssetRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const emptyForm = {
  assetTag: "",
  name: "",
  model: "",
  serial: "",
  location: "",
  condition: "in-service" as const,
  selectedId: null as string | null,
}

export const ListAssets = Command.define("ListAssets", {
  args: {
    filterAssetTag: Schema.String,
    filterLocation: Schema.String,
    filterCondition: Schema.String,
  },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ filterAssetTag, filterLocation, filterCondition }) => pipe(
    rpcCall({
      tag: "assets.list",
      payload: {
        filter: {
          ...(filterAssetTag.trim() === "" ? {} : { assetTag: filterAssetTag.trim() }),
          ...(filterLocation.trim() === "" ? {} : { location: filterLocation.trim() }),
          ...(filterCondition === "" ? {} : { condition: filterCondition }),
        },
        limit: 100,
      },
      token: null,
      success: AssetPageSchema,
    }),
    Effect.match({
      onSuccess: (page) => Message.SucceededList({ items: page.items }),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }),
  ),
})

export const SaveAsset = Command.define("SaveAsset", {
  args: {
    selectedId: Schema.NullOr(Schema.String),
    assetTag: Schema.String,
    name: Schema.String,
    model: Schema.String,
    serial: Schema.String,
    location: Schema.String,
    condition: AssetConditionSchema,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const asset = {
      assetTag: args.assetTag.trim(),
      name: args.name.trim(),
      model: args.model.trim(),
      serial: args.serial.trim() === "" ? null : args.serial.trim(),
      location: args.location.trim(),
      condition: args.condition,
    }
    const creating = args.selectedId === null
    return pipe(
      rpcCall({
        tag: creating ? "assets.create" : "assets.update",
        payload: creating ? asset : { id: args.selectedId, ...asset },
        token: null,
        success: AssetRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ asset: saved, created: creating }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveAsset = Command.define("RemoveAsset", {
  args: { id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id }) => pipe(
    rpcCall({
      tag: "assets.remove",
      payload: { id },
      token: null,
      success: Schema.Null,
    }),
    Effect.match({
      onSuccess: () => Message.SucceededRemove({ id }),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }),
  ),
})

const reload = (model: Model) => ListAssets({
  filterAssetTag: model.filterAssetTag,
  filterLocation: model.filterLocation,
  filterCondition: model.filterCondition,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedFilterAssetTag: ({ value }) => ({ model: evo(model, { filterAssetTag: () => value }) }),
    ChangedFilterLocation: ({ value }) => ({ model: evo(model, { filterLocation: () => value }) }),
    ChangedFilterCondition: ({ value }) => ({ model: evo(model, { filterCondition: () => value }) }),
    ChangedAssetTag: ({ value }) => ({ model: evo(model, { assetTag: () => value }) }),
    ChangedName: ({ value }) => ({ model: evo(model, { name: () => value }) }),
    ChangedModel: ({ value }) => ({ model: evo(model, { model: () => value }) }),
    ChangedSerial: ({ value }) => ({ model: evo(model, { serial: () => value }) }),
    ChangedLocation: ({ value }) => ({ model: evo(model, { location: () => value }) }),
    ChangedCondition: ({ value }) => ({
      model: evo(model, { condition: () => value as Model["condition"] }),
    }),
    ClickedReload: () => ({
      model: evo(model, { listing: () => true, notice: () => null }),
      commands: [reload(model)],
    }),
    ClickedSave: () => ({
      model: evo(model, { saving: () => true, notice: () => null }),
      commands: [SaveAsset({
        selectedId: model.selectedId,
        assetTag: model.assetTag,
        name: model.name,
        model: model.model,
        serial: model.serial,
        location: model.location,
        condition: model.condition,
      })],
    }),
    ClickedNew: () => ({
      model: evo(model, {
        assetTag: () => "",
        name: () => "",
        model: () => "",
        serial: () => "",
        location: () => "",
        condition: () => "in-service",
        selectedId: () => null,
        notice: () => null,
      }),
    }),
    ClickedSelect: ({ id }) =>
      Option.match(Array.findFirst(model.assets, (item) => item.id === id), {
        onNone: () => ({ model }),
        onSome: (asset) => ({
          model: evo(model, {
            assetTag: () => asset.assetTag,
            name: () => asset.name,
            model: () => asset.model,
            serial: () => asset.serial ?? "",
            location: () => asset.location,
            condition: () => asset.condition,
            selectedId: () => asset.id,
            notice: () => null,
          }),
        }),
      }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { saving: () => true, notice: () => null }),
      commands: [RemoveAsset({ id })],
    }),
    SucceededList: ({ items }) => ({
      model: evo(model, { assets: () => items, listing: () => false, saving: () => false }),
    }),
    SucceededSave: ({ asset, created }) => ({
      model: evo(model, {
        assetTag: () => asset.assetTag,
        name: () => asset.name,
        model: () => asset.model,
        serial: () => asset.serial ?? "",
        location: () => asset.location,
        condition: () => asset.condition,
        selectedId: () => asset.id,
        listing: () => true,
        saving: () => false,
        notice: () => ({ kind: "success" as const, text: created ? "Asset registered." : "Asset updated." }),
      }),
      commands: [reload(model)],
    }),
    SucceededRemove: ({ id }) => ({
      model: evo(model, {
        assetTag: () => model.selectedId === id ? "" : model.assetTag,
        name: () => model.selectedId === id ? "" : model.name,
        model: () => model.selectedId === id ? "" : model.model,
        serial: () => model.selectedId === id ? "" : model.serial,
        location: () => model.selectedId === id ? "" : model.location,
        condition: () => model.selectedId === id ? "in-service" : model.condition,
        selectedId: () => model.selectedId === id ? null : model.selectedId,
        listing: () => true,
        saving: () => false,
        notice: () => ({ kind: "success" as const, text: "Asset removed." }),
      }),
      commands: [reload(model)],
    }),
    Failed: ({ error }) => ({
      model: evo(model, {
        listing: () => false,
        saving: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    assets: [],
    filterAssetTag: "",
    filterLocation: "",
    filterCondition: "",
    ...emptyForm,
    listing: true,
    saving: false,
    notice: null,
  },
  commands: [ListAssets({ filterAssetTag: "", filterLocation: "", filterCondition: "" })],
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Equipment register",
  body: shell(h, {
    title: "Equipment register",
    lede: "Register equipment, track where it is, and keep its service status current.",
    notice: model.notice,
    session: null,
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel stack")],
            [
              h.div(
                [h.Class("actions")],
                [
                  field(h, {
                    id: "filter-asset-tag",
                    label: "Filter tag",
                    children: textInput(h, {
                      id: "filter-asset-tag",
                      value: model.filterAssetTag,
                      onInput: (value) => Message.ChangedFilterAssetTag({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "filter-location",
                    label: "Filter location",
                    children: textInput(h, {
                      id: "filter-location",
                      value: model.filterLocation,
                      onInput: (value) => Message.ChangedFilterLocation({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "filter-condition",
                    label: "Filter condition",
                    children: selectInput(h, {
                      id: "filter-condition",
                      value: model.filterCondition,
                      onChange: (value) => Message.ChangedFilterCondition({ value }),
                      choices: conditionChoices,
                    }),
                  }),
                  primaryButton(h, {
                    label: model.listing ? "Loading…" : "Reload",
                    message: Option.some(Message.ClickedReload()),
                    type: "button",
                    disabled: model.listing,
                  }),
                ],
              ),
              dataTable(h, {
                caption: "Assets",
                columns: ["Asset tag", "Name", "Model", "Serial", "Location", "Condition", ""],
                rows: model.assets,
                key: (asset) => asset.id,
                cells: (asset) => [
                  asset.assetTag,
                  asset.name,
                  asset.model,
                  asset.serial ?? "—",
                  asset.location,
                  asset.condition,
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: asset.id }), disabled: false }),
                      quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: asset.id }), disabled: model.saving }),
                    ],
                  ),
                ],
              }),
            ],
          ),
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedSave())],
                [
                  h.h2([], [model.selectedId === null ? "Register an asset" : "Edit asset"]),
                  field(h, {
                    id: "asset-tag",
                    label: "Asset tag",
                    children: textInput(h, {
                      id: "asset-tag",
                      value: model.assetTag,
                      onInput: (value) => Message.ChangedAssetTag({ value }),
                      type: "text",
                      placeholder: "EQ-CAM2048",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "name",
                    label: "Name",
                    children: textInput(h, {
                      id: "name",
                      value: model.name,
                      onInput: (value) => Message.ChangedName({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "model",
                    label: "Model",
                    children: textInput(h, {
                      id: "model",
                      value: model.model,
                      onInput: (value) => Message.ChangedModel({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "serial",
                    label: "Serial number",
                    children: textInput(h, {
                      id: "serial",
                      value: model.serial,
                      onInput: (value) => Message.ChangedSerial({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "location",
                    label: "Location",
                    children: textInput(h, {
                      id: "location",
                      value: model.location,
                      onInput: (value) => Message.ChangedLocation({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "condition",
                    label: "Condition",
                    children: selectInput(h, {
                      id: "condition",
                      value: model.condition,
                      onChange: (value) => Message.ChangedCondition({ value }),
                      choices: formConditionChoices,
                    }),
                  }),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, {
                        label: model.selectedId === null ? "Register asset" : "Save changes",
                        message: Option.none(),
                        type: "submit",
                        disabled: model.saving,
                      }),
                      quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false }),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  }),
})
