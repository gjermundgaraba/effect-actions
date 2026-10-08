import { Schema, type SchemaAST } from "effect";

/**
 * The annotation marking a media kind's schema, naming the MCP content block a value of it is
 * lifted into: `Action.Image`'s is `"image"`.
 */
const mediaKey = "effect-actions/media";

/** A media kind, by the content block its values are lifted into. */
export type Kind = "image";

/** What every media kind holds: bytes, and their MIME type. */
export const Media = Schema.Struct({ data: Schema.Uint8Array, mimeType: Schema.String });

/** An image, a media field's schema, as `Action.Image` exports it. */
export const Image = Media.annotate({ [mediaKey]: "image" });

/**
 * Whether `ast` is marked as media, read from its own annotations: a copy, such as an optional
 * key or one with checks added, keeps them, and so does one with an encoding of its own.
 */
export const isMarked = (ast: SchemaAST.AST): boolean => ast.annotations?.[mediaKey] === "image";

/**
 * The kind `ast` is, when its values are the media they encode to: marked, without an encoding
 * of its own, which would send its values as something else.
 */
export const kindOf = (ast: SchemaAST.AST): Kind | undefined =>
  isMarked(ast) && ast.encoding === undefined ? "image" : undefined;
