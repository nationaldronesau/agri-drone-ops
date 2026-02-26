export interface AnnotationClassErrorMapping {
  status: number;
  message: string;
  code: string;
}

export function mapAnnotationClassError(error: unknown): AnnotationClassErrorMapping {
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      message: 'Invalid request body - could not parse JSON',
      code: 'INVALID_JSON',
    };
  }

  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    if (error.code === 'P2002') {
      return {
        status: 409,
        message: 'A class with this name already exists in this project',
        code: 'DUPLICATE_CLASS_NAME',
      };
    }

    if (error.code === 'P2025') {
      return {
        status: 404,
        message: 'Annotation class not found',
        code: 'ANNOTATION_CLASS_NOT_FOUND',
      };
    }

    if (['P1000', 'P1001', 'P1002', 'P1017', 'P2024'].includes(error.code)) {
      return {
        status: 503,
        message: 'Annotation classes temporarily unavailable',
        code: 'ANNOTATION_CLASSES_TEMP_UNAVAILABLE',
      };
    }
  }

  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    if (error.name === 'PrismaClientValidationError') {
      return {
        status: 400,
        message: 'Invalid annotation classes request',
        code: 'ANNOTATION_CLASSES_INVALID_REQUEST',
      };
    }

    if (
      error.name === 'PrismaClientKnownRequestError' ||
      error.name === 'PrismaClientUnknownRequestError' ||
      error.name === 'PrismaClientRustPanicError' ||
      error.name === 'PrismaClientInitializationError'
    ) {
      return {
        status: 503,
        message: 'Annotation classes temporarily unavailable',
        code: 'ANNOTATION_CLASSES_TEMP_UNAVAILABLE',
      };
    }
  }

  return {
    status: 503,
    message: 'Annotation classes temporarily unavailable',
    code: 'ANNOTATION_CLASSES_UNAVAILABLE',
  };
}
