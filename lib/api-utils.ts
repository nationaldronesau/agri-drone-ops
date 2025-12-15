import { NextResponse } from 'next/server';

/**
 * Safe error messages for API responses.
 * Maps internal error contexts to user-friendly messages.
 * Internal details are logged server-side but not exposed to clients.
 */

type ErrorContext =
  | 'upload'
  | 'database'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 's3'
  | 'roboflow'
  | 'sam3'
  | 'training'
  | 'detection'
  | 'annotation'
  | 'project'
  | 'export'
  | 'general';

const SAFE_ERROR_MESSAGES: Record<ErrorContext, string> = {
  upload: 'Failed to upload file. Please try again.',
  database: 'A database error occurred. Please try again.',
  auth: 'Authentication failed. Please sign in again.',
  validation: 'Invalid request data. Please check your input.',
  not_found: 'The requested resource was not found.',
  s3: 'File storage operation failed. Please try again.',
  roboflow: 'Training service error. Please try again.',
  sam3: 'Segmentation service error. Please try again.',
  training: 'Training operation failed. Please try again.',
  detection: 'Detection operation failed. Please try again.',
  annotation: 'Annotation operation failed. Please try again.',
  project: 'Project operation failed. Please try again.',
  export: 'Export operation failed. Please try again.',
  general: 'An unexpected error occurred. Please try again.',
};

/**
 * Logs error details server-side and returns a safe error response.
 *
 * @param error - The caught error object
 * @param context - The error context for selecting appropriate user message
 * @param logPrefix - Prefix for server-side log message
 * @param statusCode - HTTP status code (default 500)
 * @returns NextResponse with safe error message
 */
export function safeErrorResponse(
  error: unknown,
  context: ErrorContext = 'general',
  logPrefix: string = 'API Error',
  statusCode: number = 500
): NextResponse {
  // Log full error details server-side for debugging
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  const errorStack = error instanceof Error ? error.stack : undefined;

  console.error(`[${logPrefix}] ${errorMessage}`);
  if (errorStack && process.env.NODE_ENV === 'development') {
    console.error(errorStack);
  }

  // Return safe message to client
  return NextResponse.json(
    { error: SAFE_ERROR_MESSAGES[context] },
    { status: statusCode }
  );
}

/**
 * Creates a safe 400 Bad Request response for validation errors.
 * Can include field-specific errors without exposing internal details.
 */
export function validationErrorResponse(
  message: string = 'Invalid request data',
  fields?: Record<string, string>
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      ...(fields && { fields })
    },
    { status: 400 }
  );
}

/**
 * Creates a safe 401 Unauthorized response.
 */
export function unauthorizedResponse(
  message: string = 'Authentication required'
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 401 }
  );
}

/**
 * Creates a safe 403 Forbidden response.
 */
export function forbiddenResponse(
  message: string = 'You do not have permission to perform this action'
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 403 }
  );
}

/**
 * Creates a safe 404 Not Found response.
 */
export function notFoundResponse(
  resource: string = 'Resource'
): NextResponse {
  return NextResponse.json(
    { error: `${resource} not found` },
    { status: 404 }
  );
}
