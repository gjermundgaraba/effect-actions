import { Schema, type SchemaAST } from "effect";

const mediaKindAnnotation = "effect-actions/media";

/** A media kind, by the content block its values are lifted into. */
export type Kind = "image";

/** What every media kind holds: bytes, and their MIME type. */
export const Media = Schema.Struct({ data: Schema.Uint8Array, mimeType: Schema.String });

/**
 * An image, a media field of a success: `{ data: Uint8Array, mimeType: string }`, `mimeType` such
 * as `image/png`. A top-level field of a struct success, optional or an array, or the whole
 * success, one or an array: an MCP tool lifts it into an image block of its own, and every other
 * surface sends it as JSON, the bytes in base64. `ActionMcp` refuses it anywhere else.
 */
export const Image = Media.annotate({ [mediaKindAnnotation]: "image" });

/**
 * Whether `ast` is marked as media, read from its own annotations: a copy, such as an optional
 * key or one with checks added, keeps them, and so does one with an encoding of its own.
 */
export const isMarked = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.[mediaKindAnnotation] === "image";

/**
 * The kind `ast` is, when its values are the media they encode to: marked, without an encoding
 * of its own, which would send its values as something else.
 */
export const kindOf = (ast: SchemaAST.AST): Kind | undefined =>
  isMarked(ast) && ast.encoding === undefined ? "image" : undefined;
