import type { APIRoute } from "astro";
import { requestDeviceCode } from "../../../../../lib/auth/github";
import { jsonResponse, errorResponse } from "../../../../../lib/api/response";

export const prerender = false;

export const POST: APIRoute = async () => {
  const deviceCode = await requestDeviceCode();

  if (!deviceCode) {
    return errorResponse(502, "Failed to request device code from GitHub");
  }

  return jsonResponse({
    device_code: deviceCode.device_code,
    user_code: deviceCode.user_code,
    verification_uri: deviceCode.verification_uri,
    expires_in: deviceCode.expires_in,
    interval: deviceCode.interval,
  });
};
