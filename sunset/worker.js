// emdashcms.org closed on 28 September 2026. This worker replaces the
// registry app: the home page explains why, every other path answers
// 410 Gone with the same notice so search engines drop old listings.

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>emdashcms.org has closed</title>
<meta name="description" content="The community EmDash plugin and theme registry has closed. EmDash 1.0 now ships an official, decentralised plugin registry.">
<style>
  :root { --bg: #faf7f2; --fg: #1f1b16; --muted: #6b6259; --accent: #b4441c; --rule: #e6dfd4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17140f; --fg: #f1ebe2; --muted: #a89e92; --accent: #f08a5d; --rule: #2e2922; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.65 Georgia, "Iowan Old Style", serif; }
  main { max-width: 38rem; margin: 0 auto; padding: 4rem 1rem 5rem; }
  .mark { font-size: 3rem; line-height: 1; color: var(--accent); margin: 0 0 1.5rem; }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1.5rem; font-weight: 600; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .5rem; }
  p { margin: 0 0 1rem; }
  a { color: var(--accent); }
  .cta { display: inline-block; margin: .5rem 0 1rem; padding: .7rem 1.2rem; background: var(--accent); color: var(--bg); text-decoration: none; border-radius: 4px; font-family: system-ui, sans-serif; font-size: 1rem; font-weight: 600; }
  footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
  <p class="mark" aria-hidden="true">&mdash;</p>
  <h1>emdashcms.org has closed</h1>

  <p>We started this site in April 2026 because EmDash had plugins but nowhere to share them. Our aim was to build a community registry for plugins and themes, and to hand it upstream once it proved itself.</p>

  <p>On 28 September 2026 EmDash 1.0 shipped with an <strong>official plugin registry</strong>. It is built on AT Protocol, so publishers keep their own identity and releases. Site owners can discover, inspect and install plugins straight from the EmDash admin. That covers what this site set out to do, so running a second catalogue alongside it would only split the ecosystem.</p>

  <a class="cta" href="https://plugins.emdashcms.com">Browse the official registry &rarr;</a>

  <h2>If you published here</h2>
  <p>Your plugins and themes are no longer listed on this site. To keep them discoverable, publish them to the official registry with an Atmosphere account. The <a href="https://blog.cloudflare.com/emdash-cms-plugin-registry/">EmDash 1.0 announcement</a> links to the step-by-step publishing guide. We have deleted all account data, uploads and audit records.</p>

  <h2>Thank you</h2>
  <p>Thank you to the 37 developers who signed in, and especially to everyone who trusted an unofficial registry with their work and published plugins or themes here. Thank you too to the EmDash maintainers and contributors for building something worth making a registry for.</p>

  <footer>
    Built by <a href="https://github.com/chrisjohnleah">Christopher Leah</a>. The source is archived at <a href="https://github.com/chrisjohnleah/emdashcms-org">github.com/chrisjohnleah/emdashcms-org</a>. EmDash itself lives at <a href="https://emdashcms.com">emdashcms.com</a>.
  </footer>
</main>
</body>
</html>`;

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    }
    return new Response(page, {
      status: pathname === "/" ? 200 : 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  },
};
