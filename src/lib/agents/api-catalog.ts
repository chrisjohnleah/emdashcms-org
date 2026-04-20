const SITE_URL = "https://emdashcms.org";

export interface ApiCatalog {
  linkset: Array<{
    anchor: string;
    "service-desc"?: Array<{ href: string; type: string }>;
    "service-doc"?: Array<{ href: string; type: string }>;
    status?: Array<{ href: string; type: string }>;
    "terms-of-service"?: Array<{ href: string }>;
  }>;
}

export function buildApiCatalog(): ApiCatalog {
  return {
    linkset: [
      {
        anchor: `${SITE_URL}/api/v1`,
        "service-desc": [
          {
            href: `${SITE_URL}/api/v1/openapi.json`,
            type: "application/vnd.oai.openapi+json",
          },
        ],
        "service-doc": [
          {
            href: `${SITE_URL}/docs/contributors`,
            type: "text/html",
          },
        ],
        status: [
          {
            href: `${SITE_URL}/api/v1/plugins?limit=1`,
            type: "application/json",
          },
        ],
        "terms-of-service": [{ href: `${SITE_URL}/terms` }],
      },
    ],
  };
}
