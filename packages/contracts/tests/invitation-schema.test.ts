import { describe, expect, it } from 'vitest';
import { invitationAcceptSchema, invitationCreateSchema } from '../src/index.js';

describe('invitationCreateSchema', () => {
  it('accepts the three invitable roles and normalizes email casing', () => {
    for (const role of ['EDITOR', 'COMMENTER', 'VIEWER'] as const) {
      const parsed = invitationCreateSchema.parse({ email: 'Foo@Example.COM', role });
      expect(parsed.email).toBe('foo@example.com');
      expect(parsed.role).toBe(role);
    }
  });

  it('rejects the OWNER role', () => {
    const parsed = invitationCreateSchema.safeParse({
      email: 'owner@example.com',
      role: 'OWNER',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects ttl values outside the 5 minutes to 30 days window', () => {
    expect(
      invitationCreateSchema.safeParse({
        email: 'a@example.com',
        role: 'VIEWER',
        ttlSeconds: 299,
      }).success,
    ).toBe(false);
    expect(
      invitationCreateSchema.safeParse({
        email: 'a@example.com',
        role: 'VIEWER',
        ttlSeconds: 30 * 24 * 60 * 60 + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts boundary ttl values and makes it optional', () => {
    expect(
      invitationCreateSchema.parse({
        email: 'a@example.com',
        role: 'VIEWER',
        ttlSeconds: 5 * 60,
      }).ttlSeconds,
    ).toBe(300);
    expect(
      invitationCreateSchema.parse({
        email: 'a@example.com',
        role: 'VIEWER',
        ttlSeconds: 30 * 24 * 60 * 60,
      }).ttlSeconds,
    ).toBe(30 * 24 * 60 * 60);
    expect(
      invitationCreateSchema.parse({ email: 'a@example.com', role: 'VIEWER' }).ttlSeconds,
    ).toBeUndefined();
  });

  it('rejects unknown fields', () => {
    expect(
      invitationCreateSchema.safeParse({
        email: 'a@example.com',
        role: 'VIEWER',
        tokenHash: 'leak',
      }).success,
    ).toBe(false);
  });
});

describe('invitationAcceptSchema', () => {
  it('requires a token long enough to be a real invitation token', () => {
    expect(invitationAcceptSchema.safeParse({ token: 'short' }).success).toBe(false);
    const token = 'wvinv_'.concat('a'.repeat(43));
    expect(invitationAcceptSchema.parse({ token }).token).toBe(token);
  });
});
