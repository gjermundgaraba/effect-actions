import { Schema, type SchemaAST } from "effect";

const mediaKindAnnotation = "effect-actions/media";

// Why: Text is no kind. A host given `structuredContent` shows its model that and drops the text
// blocks beside it, so a lifted string reaches a model only from a tool that sends no structured
// content.
export type Kind = "image";

export const Media = Schema.Struct({ data: Schema.Uint8Array, mimeType: Schema.String });

/**
 * An image, a media field of a success: `{ data: Uint8Array, mimeType: string }`, `mimeType` such
 * as `image/png`. A top-level field of a struct success, one, optional, or a required array, or the
 * whole success, one or an array: an MCP tool lifts it into an image block of its own, and every other
 * surface sends it as JSON, the bytes in base64. `ActionMcp` refuses it anywhere else.
 *
 * **Gotchas**
 *
 * - A media field's own `description` reaches no model: describe the image in the action's `description`.
 */
export const Image = Media.annotate({ [mediaKindAnnotation]: "image" });

export const isMarked = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.[mediaKindAnnotation] === "image";

export const kindOf = (ast: SchemaAST.AST): Kind | undefined =>
  isMarked(ast) && ast.encoding === undefined ? "image" : undefined;
