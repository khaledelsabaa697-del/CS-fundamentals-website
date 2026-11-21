import "server-only";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileFailureCode =
  | "not_configured"
  | "missing_token"
  | "verification_failed";

export type TurnstileResult =
  | { ok: true }
  | { ok: false; code: TurnstileFailureCode };

/**
 * Verify a Cloudflare Turnstile token.
 *
 * The public site key is the feature switch: when it is missing the widget is
 * not rendered and the client sends no token. In development that means the
 * check is skipped (with a warning); in production a missing key fails closed.
 */
export async function verifyTurnstile(token: string | null): Promise<TurnstileResult> {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!siteKey || !secretKey) {
    if (isProduction) {
      console.error(
        "[Turnstile] CAPTCHA is not fully configured in production; rejecting the request. Site key present:", Boolean(siteKey), "Secret key present:", Boolean(secretKey),
      );
      return { ok: false, code: "not_configured" };
    }

    console.warn(
      `[Turnstile] ${!siteKey ? "Site" : "Secret"} key is not configured; skipping CAPTCHA verification in development.`,
    );
    return { ok: true };
  }

  if (!token) {
    console.warn("[Turnstile] No token provided");
    return { ok: false, code: "missing_token" };
  }

  try {
    const formData = new FormData();
    formData.append("secret", secretKey);
    formData.append("response", token);

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: formData,
    });

    const data: { success?: boolean; "error-codes"?: string[] } = await response.json();

    console.log("[Turnstile] Verification response:", { success: data.success, errorCodes: data["error-codes"] });

    if (data.success) {
      return { ok: true };
    }

    console.error("[Turnstile] Verification failed:", data["error-codes"]);
    return { ok: false, code: "verification_failed" };
  } catch (error) {
    console.error("[Turnstile] Verification error:", error);
    return { ok: false, code: "verification_failed" };
  }
}

export function getTurnstileSiteKey(): string | undefined {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}
