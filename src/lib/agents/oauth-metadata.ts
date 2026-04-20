const ISSUER = "https://emdashcms.org";

// TODO(agent-readiness): add `jwks_uri` when the JWT signing layer migrates
// from HS256 (shared secret) to RS256/EdDSA with a public verification key.
// Until then, tokens are validated server-side only — publishing a JWKS
// document would be misleading.

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  grant_types_supported: string[];
  response_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
}

export function buildAuthorizationServerMetadata(): OAuthAuthorizationServerMetadata {
  return {
    issuer: ISSUER,
    device_authorization_endpoint: `${ISSUER}/api/v1/auth/device/code`,
    token_endpoint: `${ISSUER}/api/v1/auth/device/token`,
    grant_types_supported: [
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "publish"],
    service_documentation: `${ISSUER}/docs/contributors`,
  };
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_documentation: string;
}

export function buildProtectedResourceMetadata(): OAuthProtectedResourceMetadata {
  return {
    resource: `${ISSUER}/api/v1`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "publish"],
    resource_documentation: `${ISSUER}/docs/contributors`,
  };
}
