type StructuredLogLevel = 'info' | 'warn' | 'error';

export interface StructuredLogFields {
  [key: string]: unknown;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

export function logStructured(
  level: StructuredLogLevel,
  event: string,
  fields: StructuredLogFields = {}
): void {
  const normalizedFields: StructuredLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    normalizedFields[key] = normalizeValue(value);
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...normalizedFields,
  };

  let message: string;
  try {
    message = JSON.stringify(payload);
  } catch (error) {
    message = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'structured_log_serialize_error',
      originalEvent: event,
      error: normalizeValue(error),
    });
  }

  if (level === 'error') {
    console.error(message);
    return;
  }
  if (level === 'warn') {
    console.warn(message);
    return;
  }
  console.log(message);
}
