import { NextResponse } from 'next/server';

/**
 * Checks if the current environment is NOT development and returns a 404 response if so.
 * This is a "fail-closed" approach - blocks access unless explicitly in development.
 * Use this at the top of debug/test endpoints to block access in production.
 *
 * @returns NextResponse if not in development (caller should return this), undefined if dev
 *
 * @example
 * export async function GET(request: NextRequest) {
 *   const prodBlock = blockInProduction();
 *   if (prodBlock) return prodBlock;
 *   // ... rest of endpoint logic
 * }
 */
export function blockInProduction(): NextResponse | undefined {
  // Fail-closed: only allow in development, block everything else
  // This protects against misconfigured environments (staging, undefined NODE_ENV, etc.)
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is not available in production' },
      { status: 404 }
    );
  }
  return undefined;
}
