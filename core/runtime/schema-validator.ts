import type { ZodTypeAny } from 'zod';

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  additionalProperties?: boolean | JsonSchemaProperty;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

type JsonSchema = JsonSchemaProperty & {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
};

function typeMatches(value: unknown, expected?: string): boolean {
  if (!expected) return true;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'null') return value === null;
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === expected;
}

function validateValue(value: unknown, schema: JsonSchemaProperty, path: string): string[] {
  const errors: string[] = [];

  // oneOf / anyOf
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validateValue(value, s, path).length === 0);
    if (matches.length !== 1) errors.push(`${path}: must match exactly one of oneOf schemas`);
    return errors;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((s) => validateValue(value, s, path).length === 0);
    if (!matches) errors.push(`${path}: must match at least one of anyOf schemas`);
    return errors;
  }

  // type check
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${schema.type}`);
    return errors;
  }

  // enum
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum`);
  }

  // string constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: string does not match pattern ${schema.pattern}`);
    }
  }

  // number constraints
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: value below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: value above maximum ${schema.maximum}`);
    }
  }

  // nested object
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${path}.${key}: missing required field`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        errors.push(...validateValue(obj[key], propSchema, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }

  // array items
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateValue(value[i], schema.items, `${path}[${i}]`));
    }
  }

  return errors;
}

export function validateWithZod(schema: ZodTypeAny, payload: unknown): string[] {
  const result = schema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`);
}

export function validateAgainstJsonSchema(schema: JsonSchema, payload: unknown): string[] {
  if (schema.type === 'object') {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return ['Payload must be an object'];
    }
  }
  return validateValue(payload, schema, 'root');
}
