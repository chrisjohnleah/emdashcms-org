const ONE_HOUR = "public, max-age=3600, s-maxage=3600";

function body<T>(data: T, contentType: string, cacheControl = ONE_HOUR): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    },
  });
}

export function linksetJson<T>(data: T): Response {
  return body(data, "application/linkset+json; charset=utf-8");
}

export function oauthJson<T>(data: T): Response {
  return body(data, "application/json; charset=utf-8");
}

export function mcpCardJson<T>(data: T): Response {
  return body(data, "application/json; charset=utf-8");
}

export function skillsJson<T>(data: T): Response {
  return body(data, "application/json; charset=utf-8");
}

export function markdownResponse(markdown: string): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Vary": "Accept",
    },
  });
}
