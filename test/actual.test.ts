import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// ---------------------------------------------------------------------------
// Mock @actual-app/api (no jest-style module mocking in node:test, so patch
// the require cache, same approach as test/mapper.test.ts).
// ---------------------------------------------------------------------------
interface MockState {
  loadedGroupId: string | null;
  initCalls: number;
  downloads: { syncId: string; password?: string }[];
  /** Called for each download; may throw. Default: load the requested budget. */
  onDownload: (syncId: string) => Promise<void> | void;
}

const mock: MockState = {
  loadedGroupId: null,
  initCalls: 0,
  downloads: [],
  onDownload: (syncId) => {
    mock.loadedGroupId = syncId;
  },
};

const require = createRequire(import.meta.url);
const resolvedApiPath = require.resolve('@actual-app/api');
const mockExports = {
  init: async () => {
    mock.initCalls++;
  },
  downloadBudget: async (syncId: string, opts?: { password?: string }) => {
    mock.downloads.push({ syncId, password: opts?.password });
    await mock.onDownload(syncId);
  },
  shutdown: async () => {},
  internal: {
    send: async (name: string) => {
      assert.equal(name, 'load-prefs');
      return mock.loadedGroupId === null ? null : { groupId: mock.loadedGroupId };
    },
  },
};
require.cache[resolvedApiPath] = {
  id: resolvedApiPath,
  filename: resolvedApiPath,
  loaded: true,
  parent: null,
  children: [],
  path: '',
  paths: [],
  exports: mockExports,
} as unknown as NodeJS.Module;

// CACHE_DIR is resolved from cwd at import time; keep it out of the real data dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-actual-test-'));
const originalCwd = process.cwd();
const savedEnv = {
  url: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
};
process.env.ACTUAL_SERVER_URL = 'http://actual.invalid';
process.env.ACTUAL_PASSWORD = 'secret';
process.chdir(tmpDir);
const { switchBudget, withBudget, getActualError, shutdownActual } = await import('../src/clients/actual.js');
process.chdir(originalCwd);

after(async () => {
  await shutdownActual();
  if (savedEnv.url === undefined) delete process.env.ACTUAL_SERVER_URL;
  else process.env.ACTUAL_SERVER_URL = savedEnv.url;
  if (savedEnv.password === undefined) delete process.env.ACTUAL_PASSWORD;
  else process.env.ACTUAL_PASSWORD = savedEnv.password;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function resetMock(): void {
  mock.loadedGroupId = null;
  mock.downloads = [];
  mock.onDownload = (syncId) => {
    mock.loadedGroupId = syncId;
  };
}

const downloadsOf = (syncId: string) => mock.downloads.filter((d) => d.syncId === syncId).length;

// Module state (activeSyncId, serverReady) persists across tests, so every test
// uses its own sync ids.
describe('switchBudget', () => {
  it('initialises the server once, downloads the budget and passes the encryption password', async () => {
    resetMock();
    await switchBudget({ syncId: 'sync-first', encryptionPassword: 'pw' });
    await switchBudget({ syncId: 'sync-first-other' });
    assert.equal(mock.initCalls, 1);
    assert.deepEqual(mock.downloads[0], { syncId: 'sync-first', password: 'pw' });
    assert.deepEqual(mock.downloads[1], { syncId: 'sync-first-other', password: undefined });
    assert.equal(getActualError(), null);
    assert.ok(fs.existsSync(path.join(tmpDir, 'data', 'actual-cache')), 'cache dir created under temp cwd');
  });

  it('skips the download when the same sync id is active and still loaded', async () => {
    resetMock();
    await switchBudget({ syncId: 'sync-same' });
    await switchBudget({ syncId: 'sync-same' });
    assert.equal(downloadsOf('sync-same'), 1);
  });

  it('reloads when it believes a budget is active but a different one is loaded', async () => {
    resetMock();
    await switchBudget({ syncId: 'sync-stale' });
    mock.loadedGroupId = 'someone-else'; // closed/replaced behind our back
    await switchBudget({ syncId: 'sync-stale' });
    assert.equal(downloadsOf('sync-stale'), 2);
    assert.equal(mock.loadedGroupId, 'sync-stale');
  });

  it('reloads when nothing is loaded any more', async () => {
    resetMock();
    await switchBudget({ syncId: 'sync-closed' });
    mock.loadedGroupId = null;
    await switchBudget({ syncId: 'sync-closed' });
    assert.equal(downloadsOf('sync-closed'), 2);
  });

  it('re-downloads after a failed download and records the error', async () => {
    resetMock();
    await switchBudget({ syncId: 'sync-fail' }); // known-good first
    mock.onDownload = () => {
      throw new Error('network down');
    };
    await assert.rejects(() => switchBudget({ syncId: 'sync-fail-2' }), /Failed to download Actual Budget budget sync-fail-2: .*network down/);
    assert.match(getActualError() ?? '', /network down/);

    // activeSyncId was reset: even the previously-good budget must be re-downloaded.
    mock.onDownload = (syncId) => {
      mock.loadedGroupId = syncId;
    };
    mock.loadedGroupId = 'sync-fail'; // looks loaded, but our pointer must not be trusted
    const before = downloadsOf('sync-fail');
    await switchBudget({ syncId: 'sync-fail' });
    assert.equal(downloadsOf('sync-fail'), before + 1);
    assert.equal(getActualError(), null);
  });

  it('retries the same sync id after its own failed download', async () => {
    resetMock();
    let first = true;
    mock.onDownload = (syncId) => {
      if (first) {
        first = false;
        throw new Error('flaky');
      }
      mock.loadedGroupId = syncId;
    };
    await assert.rejects(() => switchBudget({ syncId: 'sync-retry' }), /flaky/);
    await switchBudget({ syncId: 'sync-retry' });
    assert.equal(downloadsOf('sync-retry'), 2);
    assert.equal(getActualError(), null);
  });

  it('throws when the loaded groupId does not match after download and leaves the budget inactive', async () => {
    resetMock();
    mock.onDownload = () => {
      mock.loadedGroupId = 'wrong-budget'; // resolves "successfully" but opens another file
    };
    await assert.rejects(
      () => switchBudget({ syncId: 'sync-mismatch' }),
      /reported budget sync-mismatch as downloaded but has budget wrong-budget open/
    );
    assert.match(getActualError() ?? '', /wrong-budget/);

    // activeSyncId stayed null: the next call downloads again rather than skipping.
    mock.onDownload = (syncId) => {
      mock.loadedGroupId = syncId;
    };
    await switchBudget({ syncId: 'sync-mismatch' });
    assert.equal(downloadsOf('sync-mismatch'), 2);
  });

  it('reports "no budget" when nothing is open after download', async () => {
    resetMock();
    mock.onDownload = () => {};
    await assert.rejects(() => switchBudget({ syncId: 'sync-nothing' }), /has no budget open/);
  });
});

describe('withBudget', () => {
  it('switches to the budget before running fn and returns its result', async () => {
    resetMock();
    const seen = await withBudget({ syncId: 'sync-wb' }, async () => mock.loadedGroupId);
    assert.equal(seen, 'sync-wb');
  });

  it('serialises concurrent callers so budgets never interleave', async () => {
    resetMock();
    const events: string[] = [];
    const run = (syncId: string) =>
      withBudget({ syncId }, async () => {
        events.push(`start ${syncId}:${mock.loadedGroupId}`);
        await new Promise((r) => setTimeout(r, 15));
        events.push(`end ${syncId}:${mock.loadedGroupId}`);
      });

    await Promise.all([run('sync-q1'), run('sync-q2'), run('sync-q3')]);

    assert.deepEqual(events, [
      'start sync-q1:sync-q1',
      'end sync-q1:sync-q1',
      'start sync-q2:sync-q2',
      'end sync-q2:sync-q2',
      'start sync-q3:sync-q3',
      'end sync-q3:sync-q3',
    ]);
  });

  it('does not poison the queue when fn or the switch fails', async () => {
    resetMock();
    const failingFn = withBudget({ syncId: 'sync-p1' }, async () => {
      throw new Error('fn boom');
    });
    mock.onDownload = (syncId) => {
      if (syncId === 'sync-p2') throw new Error('download boom');
      mock.loadedGroupId = syncId;
    };
    const failingSwitch = withBudget({ syncId: 'sync-p2' }, async () => 'unreachable');
    const ok = withBudget({ syncId: 'sync-p3' }, async () => 'fine');

    await assert.rejects(failingFn, /fn boom/);
    await assert.rejects(failingSwitch, /download boom/);
    assert.equal(await ok, 'fine');
  });
});
