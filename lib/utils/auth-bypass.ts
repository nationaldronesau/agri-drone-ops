/**
 * Safe Development Auth Bypass
 *
 * This provides a controlled way to bypass authentication in development
 * while ensuring production never has auth disabled, even if misconfigured.
 *
 * Requirements to bypass auth:
 * 1. DISABLE_AUTH environment variable must be explicitly set to "true"
 * 2. NODE_ENV must NOT be "production" (safety net)
 *
 * Usage:
 * ```ts
 * if (!isAuthBypassed()) {
 *   const session = await getServerSession(authOptions);
 *   if (!session?.user?.id) {
 *     return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *   }
 * }
 * ```
 */

// Module-level flag to ensure warning is only logged once
let hasLoggedWarning = false;

export function isAuthBypassed(): boolean {
  // Safety net: Never bypass auth in production, regardless of flags
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  // Require explicit opt-in via environment variable
  if (process.env.DISABLE_AUTH === 'true') {
    // Log warning only once per server instance to avoid log spam
    if (!hasLoggedWarning && typeof window === 'undefined') {
      console.warn('⚠️ Authentication is disabled - development mode only');
      hasLoggedWarning = true;
    }
    return true;
  }

  return false;
}
