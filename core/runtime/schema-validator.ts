import type { ZodTypeAny } from 'zod';

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
};

function typeMatches(value: unknown, expected?: string): boolean {
  if (!expected) return true;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

export function validateWithZod(schema: ZodTypeAny, payload: unknown): string[] {
  const result = schema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`);
}

export function validateAgainstJsonSchema(schema: JsonSchema, payload: unknown): string[] {
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return ['Payload must be an object'];
    }
  }

  const obj = payload as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (!(key in obj)) {
      errors.push(`Missing required field: ${key}`);
    }
  }

  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue;
    const val = obj[key];

    if (!typeMatches(val, rule.type)) {
      errors.push(`Invalid type for ${key}: expected ${rule.type}`);
      continue;
    }

    if (rule.enum && !rule.enum.includes(val)) {
      errors.push(`Invalid value for ${key}: not in enum`);
    }
  }

  return errors;
}
