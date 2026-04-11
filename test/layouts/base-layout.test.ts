import { describe, it } from "vitest";
// Coverage for FEED-07 BaseLayout <link rel="alternate"> emission.

describe("BaseLayout feeds prop", () => {
  it.todo(
    "emits <link rel=\"alternate\" type=\"application/atom+xml\"> with absolute URL when feeds prop is undefined (SITE_WIDE_FEEDS default)",
  );
  it.todo("emits one <link rel=\"alternate\"> per entry when feeds prop is provided");
  it.todo(
    "emits ZERO <link rel=\"alternate\"> tags on dashboard pages (currentPath.startsWith('/dashboard'))",
  );
  it.todo("always uses absolute URLs (https://emdashcms.org/...) in href attributes");
});
