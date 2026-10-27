import { SchemaAST } from "effect";

export const unsuspended = (ast: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? unsuspended(ast.thunk()) : ast;

export const members = (ast: SchemaAST.AST): readonly SchemaAST.AST[] => {
  const resolved = unsuspended(ast);

  return SchemaAST.isUnion(resolved)
    ? resolved.types.flatMap(members)
    : [resolved];
};

export const literalValues = (ast: SchemaAST.AST): readonly unknown[] => {
  if (SchemaAST.isLiteral(ast)) {
    return [ast.literal];
  }

  return SchemaAST.isEnum(ast)
    ? ast.enums.map(([, value]) => value)
    : [undefined];
};
