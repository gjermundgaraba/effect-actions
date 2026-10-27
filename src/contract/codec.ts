import { Schema } from "effect";

/** A schema a contract holds: one with no services to decode or encode. */
export type Codec = Schema.Codec<unknown>;

/** Struct fields, given in place of a schema. */
export type Fields = Readonly<Record<string, Codec>>;

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

export const codecOf = (schema: Codec | Fields): Codec => {
  if (Schema.isSchema(schema)) {
    return schema;
  }

  return Reflect.ownKeys(schema).length === 0 ? NoInput : Schema.Struct(schema);
};
