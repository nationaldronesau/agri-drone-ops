import { NextResponse } from 'next/server';

/**
 * Checks if the current environment is production and returns a 404 response if so.
 * Use this at the top of debug/test endpoints to block access in production.
 *
 * @returns NextResponse if in production (caller should return this), undefined if dev
 *
 * @example
 * export async function GET(request: NextRequest) {
 *   const prodBlock = blockInProduction();
 *   if (prodBlock) return prodBlock;
 *   // ... rest of endpoint logic
 * }
 */
export function blockInProduction(): NextResponse | undefined {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'This endpoint is not available in production' },
      { status: 404 }
    );
  }
  return undefined;
}
