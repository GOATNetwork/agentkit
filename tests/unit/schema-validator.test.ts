import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateWithZod, validateAgainstJsonSchema } from '../../core/runtime/schema-validator';

describe('validateWithZod', () => {
  const schema = z.object({
    name: z.string(),
    age: z.number().min(0),
  });

  it('returns empty array for valid input', () => {
    expect(validateWithZod(schema, { name: 'Alice', age: 30 })).toEqual([]);
  });

  it('returns errors for invalid input', () => {
    const errors = validateWithZod(schema, { name: 123, age: -1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns errors for missing fields', () => {
    const errors = validateWithZod(schema, {});
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('validateAgainstJsonSchema', () => {
  const schema = {
    type: 'object',
    required: ['name', 'role'],
    properties: {
      name: { type: 'string' },
      role: { type: 'string', enum: ['admin', 'user'] },
      count: { type: 'number' },
    },
  };

  it('returns empty array for valid input', () => {
    expect(validateAgainstJsonSchema(schema, { name: 'Alice', role: 'admin' })).toEqual([]);
  });

  it('returns error for non-object payload', () => {
    const errors = validateAgainstJsonSchema(schema, 'not-object');
    expect(errors).toContain('Payload must be an object');
  });

  it('returns error for missing required field', () => {
    const errors = validateAgainstJsonSchema(schema, { name: 'Alice' });
    expect(errors.some((e) => e.includes('role') && e.includes('missing required'))).toBe(true);
  });

  it('returns error for wrong type', () => {
    const errors = validateAgainstJsonSchema(schema, { name: 'Alice', role: 'admin', count: 'abc' });
    expect(errors.some((e) => e.includes('count') && e.includes('expected type'))).toBe(true);
  });

  it('returns error for invalid enum value', () => {
    const errors = validateAgainstJsonSchema(schema, { name: 'Alice', role: 'superadmin' });
    expect(errors.some((e) => e.includes('role') && e.includes('not in enum'))).toBe(true);
  });

  it('rejects null for nested object type', () => {
    const nestedSchema = {
      type: 'object',
      properties: {
        meta: { type: 'object', properties: { key: { type: 'string' } } },
      },
    };
    const errors = validateAgainstJsonSchema(nestedSchema, { meta: null });
    expect(errors.some((e) => e.includes('meta') && e.includes('expected type object'))).toBe(true);
  });

  it('rejects array for nested object type', () => {
    const nestedSchema = {
      type: 'object',
      properties: {
        meta: { type: 'object', properties: { key: { type: 'string' } } },
      },
    };
    const errors = validateAgainstJsonSchema(nestedSchema, { meta: [1, 2] });
    expect(errors.some((e) => e.includes('meta') && e.includes('expected type object'))).toBe(true);
  });
});
