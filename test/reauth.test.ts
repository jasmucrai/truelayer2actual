import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshConnectionIfNeeded,
  ReauthRequiredError,
  type Tokens,
  type RefreshDeps,
} from '../src/auth/tokens.js';
import { resolveConnectionTokens } from '../src/commands/sync.js';

function expiredTokens(overrides: Partial<Tokens> = {}): Tokens {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function rejectingPost(payload: unknown): RefreshDeps['post'] {
  return (async () => {
    throw Object.assign(new Error('request failed'), {
      isAxiosError: true,
      response: payload,
    });
  }) as unknown as RefreshDeps['post'];
}

describe('refreshConnectionIfNeeded', () => {
  before(() => {
    process.env.TRUELAYER_CLIENT_ID = 'sandbox-test';
    process.env.TRUELAYER_CLIENT_SECRET = 'secret';
  });

  it('marks needsReauth and throws ReauthRequiredError instead of exiting', async () => {
    let patch: Partial<Tokens> | undefined;
    const post = rejectingPost({ status: 401, data: { error: 'invalid_grant' } });

    await assert.rejects(
      () =>
        refreshConnectionIfNeeded('conn_test', expiredTokens(), {
          post,
          persist: (_id, p) => {
            patch = p;
          },
        }),
      (err: unknown) => err instanceof ReauthRequiredError
    );

    assert.equal(patch?.needsReauth, true);
    assert.equal(patch?.reauthReason, 'refresh_token_invalid');
    // Must not rewrite tokens/metadata it doesn't own.
    assert.equal('accessToken' in (patch ?? {}), false);
  });

  it('does not flip needsReauth on a retryable 5xx', async () => {
    let called = false;
    const post = rejectingPost({ status: 503, data: { error: 'server_error' } });

    await assert.rejects(
      () =>
        refreshConnectionIfNeeded('conn_test', expiredTokens(), {
          post,
          persist: () => {
            called = true;
          },
        }),
      (err: unknown) => !(err instanceof ReauthRequiredError)
    );

    assert.equal(called, false);
  });

  it('does not flip needsReauth on invalid_request (likely malformed request, not a dead grant)', async () => {
    let called = false;
    const post = rejectingPost({ status: 400, data: { error: 'invalid_request' } });

    await assert.rejects(
      () =>
        refreshConnectionIfNeeded('conn_test', expiredTokens(), {
          post,
          persist: () => {
            called = true;
          },
        }),
      (err: unknown) => !(err instanceof ReauthRequiredError)
    );

    assert.equal(called, false);
  });

  it('persists only the refreshed fields, leaving metadata untouched', async () => {
    let patch: Partial<Tokens> | undefined;
    const post = (async () => ({
      data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    })) as unknown as RefreshDeps['post'];

    const accessToken = await refreshConnectionIfNeeded(
      'conn_test',
      expiredTokens({ providerDisplayName: 'Monzo', consentExpiresAt: '2026-12-01T00:00:00.000Z' }),
      {
        post,
        persist: (_id, p) => {
          patch = p;
        },
      }
    );

    assert.equal(accessToken, 'new-access');
    assert.equal(patch?.refreshToken, 'new-refresh');
    assert.equal(patch?.needsReauth, false);
    // Provider/consent metadata is owned by the callback, not the refresh.
    assert.equal('providerDisplayName' in (patch ?? {}), false);
    assert.equal('consentExpiresAt' in (patch ?? {}), false);
  });
});

describe('resolveConnectionTokens', () => {
  it('continues past a connection requiring re-auth', async () => {
    const deps = {
      loadConnection: (id: string): Tokens => expiredTokens({ refreshToken: `r-${id}` }),
      refreshConnectionIfNeeded: async (id: string): Promise<string> => {
        if (id === 'conn_b') throw new ReauthRequiredError(id, 'dead refresh token');
        return `access-${id}`;
      },
    };

    const result = await resolveConnectionTokens(['conn_a', 'conn_b', 'conn_c'], deps);

    assert.deepEqual([...result.accessTokens.keys()], ['conn_a', 'conn_c']);
    assert.deepEqual(
      result.skipped.map((s) => s.connectionId),
      ['conn_b']
    );
    assert.equal(result.errors.length, 0);
  });

  it('records non-reauth failures as errors without aborting', async () => {
    const deps = {
      loadConnection: (id: string): Tokens => expiredTokens({ refreshToken: `r-${id}` }),
      refreshConnectionIfNeeded: async (id: string): Promise<string> => {
        if (id === 'conn_b') throw new Error('network down');
        return `access-${id}`;
      },
    };

    const result = await resolveConnectionTokens(['conn_a', 'conn_b'], deps);

    assert.deepEqual([...result.accessTokens.keys()], ['conn_a']);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(
      result.errors.map((e) => e.connectionId),
      ['conn_b']
    );
  });
});
