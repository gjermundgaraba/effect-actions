import manifest from "../package.json" with { type: "json" };

/**
 * An example as a consumer writes it: each `../src/<Module>.js` import becomes the package
 * subpath. Shared by the doc snippets and the package-consumer fixture.
 *
 * @param {string} source
 */
export const published = (source) =>
  source.replace(/"\.\.\/src\/(\w+)\.js"/g, `"${manifest.name}/$1"`);
