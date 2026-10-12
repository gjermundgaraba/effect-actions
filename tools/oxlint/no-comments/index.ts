import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noProseCommentsRule } from "./rules/no-prose-comments.ts";

const noCommentsPlugin = eslintCompatPlugin({
  meta: { name: "no-comments" },
  rules: {
    "no-prose-comments": noProseCommentsRule,
  },
});

export default noCommentsPlugin;
