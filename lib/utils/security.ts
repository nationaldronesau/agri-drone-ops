/**
 * Security utilities for API endpoints
 *
 * Provides common security functions including:
 * - SSRF protection via URL allowlisting
 * - Rate limiting with in-memory store
 * - Image fetch with size/content-type validation
 */

// SSRF protection patterns - only allow trusted cloud storage and local development
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//,
  /^https:\/\/storage\.googleapis\.com\//,
  /^https:\/\/[^/]+\.blob\.core\.windows\.net\//,
  /^http:\/\/localhost(:\d+)?\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,
];

/**
 * Check if a URL is allowed for fetching (SSRF protection)
 */
export function isUrlAllowed(url: string): boolean {
  // Allow relative paths
  if (url.startsWith('/')) return true;
  // Check against allowlist patterns
  return ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Validate that a URL is safe to fetch
 * Throws an error if the URL is not allowed
 */
export function validateUrl(url: string, context: string = 'URL'): void {
  if (!url) {
    throw new Error(`${context} is required`);
  }
  if (!isUrlAllowed(url)) {
    throw new Error(`${context} is not from an allowed domain`);
  }
}

// Processing limits - drone images can be 20-50MB
export const MAX_IMAGE_SIZE = 100 * 1024 * 1024; // 100MB
export const IMAGE_TIMEOUT = 30000; // 30 seconds

/**
 * Fetch an image with SSRF protection and size/content-type validation
 */
export async function fetchImageSafely(
  url: string,
  context: string = 'Image'
): Promise<Buffer> {
  validateUrl(url, context);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${context}: ${response.status}`);
  }

  // Validate content type
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`${context} has invalid content type: ${contentType}`);
  }

  // Check content length if available
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
    throw new Error(`${context} exceeds maximum size of ${MAX_IMAGE_SIZE / 1024 / 1024}MB`);
  }

  const arrayBuffer = await response.arrayBuffer();

  // Verify actual size
  if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error(`${context} exceeds maximum size of ${MAX_IMAGE_SIZE / 1024 / 1024}MB`);
  }

  return Buffer.from(arrayBuffer);
}

// Simple in-memory rate limiter
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up old entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

/**
 * Check rate limit for a given key
 * Returns true if the request is allowed, false if rate limited
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig = { maxRequests: 10, windowMs: 60000 }
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetTime < now) {
    // New window
    const newEntry = {
      count: 1,
      resetTime: now + config.windowMs,
    };
    rateLimitStore.set(key, newEntry);
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetTime: newEntry.resetTime,
    };
  }

  if (entry.count >= config.maxRequests) {
    // Rate limited
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
    };
  }

  // Increment counter
  entry.count++;
  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetTime: entry.resetTime,
  };
}

/**
 * Get client identifier for rate limiting
 * Uses IP address or falls back to a generic key
 */
export function getRateLimitKey(
  request: Request,
  prefix: string = 'api'
): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return `${prefix}:${ip}`;
}
