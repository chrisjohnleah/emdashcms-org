// Formula Fields — computed fields powered by user-authored expressions
// Similar to spreadsheet formulas but for your post metadata

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

/**
 * Compile a user-authored formula into a callable function.
 * The formula has access to a `post` parameter and can use any
 * standard JavaScript expression to compute a value.
 */
function compileFormula(expression) {
  // Wrap the expression in a function body so the author can use
  // statements as well as expressions. Cached so repeated evaluations
  // of the same formula don't recompile.
  return new Function("post", `return (${expression});`);
}

const formulaCache = new Map();

function getOrCompile(expression) {
  if (formulaCache.has(expression)) return formulaCache.get(expression);
  const fn = compileFormula(expression);
  formulaCache.set(expression, fn);
  return fn;
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Formula Fields installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        if (routeCtx.input?.action_id === "test_formula") {
          const expression = routeCtx.input?.values?.formula;
          const post = {
            title: "Sample post",
            wordCount: 1500,
            author: "jane",
            tags: ["javascript", "tutorial"],
          };

          try {
            const fn = getOrCompile(expression);
            const result = fn(post);
            return {
              blocks: [
                b.header("Formula Fields"),
                b.section(`Result: ${String(result)}`),
              ],
            };
          } catch (err) {
            return {
              blocks: [
                b.header("Formula Fields"),
                b.section(`Formula error: ${err.message}`),
              ],
            };
          }
        }

        return {
          blocks: [
            b.header("Formula Fields"),
            b.section("Write a formula using the `post` variable"),
            b.actions([
              e.input("formula", {
                placeholder: "post.wordCount > 1000 ? 'long' : 'short'",
              }),
              e.button("test_formula", "Evaluate", { style: "primary" }),
            ]),
          ],
        };
      },
    },
  },
});
