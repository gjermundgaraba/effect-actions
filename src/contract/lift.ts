import { Predicate, Schema, SchemaAST } from "effect";

import { unsuspended } from "./ast.js";
import type { Codec } from "./codec.js";
import type { ErasedValue } from "./implementation.js";
import { kindOf, Media } from "./media.js";
import type { Kind } from "./media.js";

const isMedia = Schema.is(Media);

const isMediaArray = Schema.is(Schema.Array(Media));

export interface Field {
  readonly name: string | undefined;
  readonly kind: Kind;
  readonly many: boolean;
}

export interface Lift {
  readonly fields: readonly Field[];
  readonly rest: Codec | undefined;
}

const kindOfUnsuspended = (ast: SchemaAST.AST) => kindOf(unsuspended(ast));

const wholeSuccessMediaOf = (suspended: SchemaAST.AST) => {
  const ast = unsuspended(suspended);
  const one = kindOf(ast);

  if (one !== undefined) {
    return { kind: one, many: false };
  }

  if (!SchemaAST.isArrays(ast) || ast.encoding !== undefined) {
    return;
  }

  const [kind, ...others] = new Set(
    [...ast.elements, ...ast.rest].map(kindOfUnsuspended)
  );

  return kind === undefined || others.length > 0
    ? undefined
    : { kind, many: true };
};

const mediaFieldOf = (field: SchemaAST.AST) => {
  const optional = field.context?.isOptional === true;
  const ast = unsuspended(field);

  if (optional && SchemaAST.isUnion(ast) && ast.types.length === 2) {
    const [definedMember, ...otherDefinedMembers] = ast.types.filter(
      (member) => !SchemaAST.isUndefined(member)
    );

    const kind =
      definedMember === undefined || otherDefinedMembers.length > 0
        ? undefined
        : kindOfUnsuspended(definedMember);

    return kind === undefined ? undefined : { kind, many: false };
  }

  const whole = wholeSuccessMediaOf(ast);

  return whole === undefined || (optional && whole.many) ? undefined : whole;
};

export const liftOf = (success: Codec): Lift => {
  const ast = unsuspended(success.ast);
  const whole = wholeSuccessMediaOf(ast);

  if (whole !== undefined) {
    return { fields: [{ name: undefined, ...whole }], rest: undefined };
  }

  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) {
    return { fields: [], rest: success };
  }

  const fields = ast.propertySignatures.flatMap(({ name, type }) => {
    const field = mediaFieldOf(type);

    return field === undefined ? [] : [{ name: String(name), ...field }];
  });

  if (fields.length === 0) {
    return { fields, rest: success };
  }

  const names = new Set<PropertyKey>(fields.map(({ name }) => name));
  const rest = ast.propertySignatures.filter(({ name }) => !names.has(name));

  const { identifier: _identifierOfWholeSuccess, ...annotationsOfRest } =
    ast.annotations ?? {};

  return {
    fields,
    rest:
      rest.length === 0 && ast.indexSignatures.length === 0
        ? undefined
        : Schema.make<Codec>(
            new SchemaAST.Objects(rest, ast.indexSignatures, annotationsOfRest)
          ),
  };
};

export interface Lifted {
  readonly kind: Kind;
  readonly field: string | undefined;
  readonly value: typeof Media.Type;
}

export const liftedFrom = (
  lift: Lift,
  success: ErasedValue
): readonly Lifted[] =>
  lift.fields.flatMap(({ name, kind, many }) => {
    const field =
      name !== undefined && Predicate.hasProperty(success, name)
        ? success[name]
        : undefined;

    const value = name === undefined ? success : field;
    const listed = isMediaArray(value) ? value : [];
    const single = isMedia(value) ? [value] : [];

    return (many ? listed : single).map((media) => ({
      kind,
      field: name,
      value: media,
    }));
  });
