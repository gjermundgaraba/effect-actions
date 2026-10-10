import { Predicate } from "effect";
import { defineRule } from "vite-plus/lint/plugins";

import type { ESTree } from "vite-plus/lint/plugins";

type Comment = ESTree.Comment;

const directivePattern = /^(?<directive>oxlint-disable-next-line|@ts-expect-error)(?=\s|$)/u;

const directiveReasonPattern = /\s--\s+\S/u;

const typeScriptPragmaPattern = /@ts-(?:expect-error|ignore)\b/u;

const isJsDocWithoutPragma = (comment: Comment): boolean =>
  comment.type === "Block" &&
  comment.value.startsWith("*") &&
  !typeScriptPragmaPattern.test(comment.value);

const directiveOf = (comment: Comment): string | undefined =>
  comment.type === "Line"
    ? directivePattern.exec(comment.value.trimStart())?.groups?.["directive"]
    : undefined;

export const noProseCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Ban prose comments. Reasoned tool directives remain, and with `allowJsDoc`, JSDoc.",
    },
    messages: {
      prose:
        "Comments are banned. What it is goes in a name or a type; why goes in a test title, a design note, or the commit message.",
      reasonlessDirective:
        "A tool directive carries its reason after ` -- `: write `// {{directive}} -- <reason>`.",
    },
    schema: [
      {
        type: "object",
        properties: { allowJsDoc: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const [options] = context.options;
    const allowJsDoc = Predicate.hasProperty(options, "allowJsDoc") && options.allowJsDoc === true;

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;

          const directive = directiveOf(comment);

          if (directive !== undefined) {
            if (directiveReasonPattern.test(comment.value)) continue;

            const example = directive === "@ts-expect-error" ? directive : comment.value.trim();

            context.report({
              loc: comment.loc,
              messageId: "reasonlessDirective",
              data: { directive: example },
            });
            continue;
          }

          if (allowJsDoc && isJsDocWithoutPragma(comment)) continue;

          context.report({ loc: comment.loc, messageId: "prose" });
        }
      },
    };
  },
});
