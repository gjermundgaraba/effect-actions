import { Schema } from "effect";

/** A schema a contract holds: one with no services to decode or encode. */
export type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Struct fields, given in place of a schema. */
export type Fields = { readonly [key: string]: Codec };

/** The input of a contract declared without one: an empty object. */
export const NoInput = Schema.Record(Schema.String, Schema.Never);

/** The schema a contract holds for `S`, given as a schema or as struct fields. */
export type CodecOf<S extends Codec | Fields> = S extends Codec
  ? S
  : S extends Schema.Struct.Fields
    ? keyof S extends never
      ? typeof NoInput
      : Extract<Schema.Struct<S>, Codec>
    : never;

export const codecOf = (schema: Codec | Fields): Codec =>
  Schema.isSchema(schema)
    ? schema
    : Reflect.ownKeys(schema).length === 0
      ? NoInput
      : Schema.Struct(schema);
