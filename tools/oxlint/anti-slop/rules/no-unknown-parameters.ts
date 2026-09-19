import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function isTypePredicateSubject(owner: ParameterOwner, parameterName: string): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

/** Disallow unknown inputs; only a type predicate's subject is legitimately unknown. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except type-predicate subjects; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        const name = functionParameterBindingName(parameter, context.sourceCode);
        if (isTypePredicateSubject(node, name)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
