// Comment Widget — drop-in comments for your posts.
// Readers can leave comments via a public route; the plugin renders
// them inline as HTML for embedding in post templates.

import { definePlugin } from "emdash";
import { blocks as b } from "@emdash-cms/blocks/server";

const MAX_COMMENT_LENGTH = 1000;

async function getComments(ctx, postId) {
  return (await ctx.kv.get(`comments:${postId}`)) ?? [];
}

async function saveComment(ctx, postId, comment) {
  const existing = await getComments(ctx, postId);
  existing.push(comment);
  await ctx.kv.set(`comments:${postId}`, existing);
}

function renderCommentsHtml(comments) {
  // Build the HTML for embedding in a post template. We use a simple
  // div-per-comment structure so themes can style it however they want.
  let html = '<div class="emdash-comments">';
  html += '<h3>Comments</h3>';

  if (comments.length === 0) {
    html += '<p class="no-comments">No comments yet. Be the first!</p>';
  } else {
    for (const c of comments) {
      html += '<div class="comment">';
      html += '<div class="comment-header">';
      html += '<strong class="author">' + c.author + '</strong>';
      html += '<time class="date">' + c.posted_at + '</time>';
      html += '</div>';
      html += '<div class="comment-body">' + c.body + '</div>';
      html += '</div>';
    }
  }

  html += '</div>';
  return html;
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Comment Widget installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (_routeCtx, ctx) => {
        const allKeys = await ctx.kv.list("comments:");
        let total = 0;
        for (const key of allKeys) {
          const c = await ctx.kv.get(key);
          total += (c ?? []).length;
        }
        return {
          blocks: [
            b.header("Comments"),
            b.section(`${total} comments across ${allKeys.length} posts.`),
          ],
        };
      },
    },
    "public/comments": {
      handler: async (routeCtx, ctx) => {
        const url = new URL(routeCtx.request.url);
        const postId = url.searchParams.get("post") ?? "";
        const comments = await getComments(ctx, postId);
        const html = renderCommentsHtml(comments);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
    "public/submit": {
      handler: async (routeCtx, ctx) => {
        try {
          const body = await routeCtx.request.json();
          if (
            !body?.postId ||
            !body?.author ||
            !body?.body ||
            body.body.length > MAX_COMMENT_LENGTH
          ) {
            return { ok: false, error: "Invalid comment" };
          }
          await saveComment(ctx, body.postId, {
            author: body.author,
            body: body.body,
            posted_at: new Date().toISOString(),
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },
  },
});
