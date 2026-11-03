import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateLoadedState, normalizeEnvPairs, quoteWindowsToken } from '../lib/index.js';

describe('normalizeEnvPairs (legacy [{ name, value }] support)', () => {
  it('converts the legacy list into a flat map', () => {
    assert.deepEqual(
      normalizeEnvPairs([{ name: 'UV_CACHE_DIR', value: '/tmp/uv' }, { name: 'A', value: '1' }]),
      { UV_CACHE_DIR: '/tmp/uv', A: '1' },
    );
  });

  it('accepts { key, value } entries and coerces values to strings', () => {
    assert.deepEqual(normalizeEnvPairs([{ key: 'N', value: 2 }]), { N: '2' });
    assert.deepEqual(normalizeEnvPairs([{ name: 'E', value: undefined }]), { E: '' });
  });

  it('drops entries without a usable name', () => {
    assert.deepEqual(normalizeEnvPairs([{ value: 'x' }, null, 'nope', 7, { name: '', value: 'x' }]), {});
  });

  it('passes the current object form through and rejects anything else', () => {
    const object = { A: '1' };
    assert.equal(normalizeEnvPairs(object), object);
    assert.deepEqual(normalizeEnvPairs(undefined), {});
    assert.deepEqual(normalizeEnvPairs('A=1'), {});
  });
});

describe('migrateLoadedState', () => {
  it('backfills a missing id on every legacy server', () => {
    const state = { servers: [{ name: 'docker' }, { name: 'github' }, { name: 'github-write' }] };
    let assigned = 0;
    const changed = migrateLoadedState(state, () => `id-${++assigned}`);
    assert.equal(changed, true);
    // Distinct ids are what keep the live-status map from cross-wiring errors.
    assert.deepEqual(state.servers.map((server) => server.id), ['id-1', 'id-2', 'id-3']);
  });

  it('keeps existing unique ids and assigns only the missing ones', () => {
    const state = { servers: [{ id: 'keep', name: 'a' }, { name: 'b' }] };
    assert.equal(migrateLoadedState(state, () => 'fresh'), true);
    assert.deepEqual(state.servers.map((server) => server.id), ['keep', 'fresh']);
  });

  it('reassigns a duplicated id so status can no longer cross over', () => {
    const state = { servers: [{ id: 'dup', name: 'a' }, { id: 'dup', name: 'b' }] };
    assert.equal(migrateLoadedState(state, () => 'new'), true);
    assert.deepEqual(state.servers.map((server) => server.id), ['dup', 'new']);
  });

  it('normalizes legacy env/header arrays in place', () => {
    const state = {
      servers: [{
        id: 'a',
        env: [{ name: 'UV_CACHE_DIR', value: '/tmp/uv' }],
        headers: [{ name: 'X-Tenant', value: 't1' }],
        headerEnv: [],
      }],
    };
    assert.equal(migrateLoadedState(state), true);
    assert.deepEqual(state.servers[0].env, { UV_CACHE_DIR: '/tmp/uv' });
    assert.deepEqual(state.servers[0].headers, { 'X-Tenant': 't1' });
    assert.deepEqual(state.servers[0].headerEnv, {});
  });

  it('reports no change for an already-migrated state', () => {
    const state = { servers: [{ id: 'a', env: { A: '1' } }], workspaceTokens: {} };
    assert.equal(migrateLoadedState(state), false);
  });

  it('tolerates malformed servers and a missing list', () => {
    assert.equal(migrateLoadedState({}), false);
    assert.equal(migrateLoadedState(undefined), false);
    assert.equal(migrateLoadedState({ servers: { nope: true } }), false);
    const state = { servers: [null, 'nope', { id: 'ok' }] };
    assert.equal(migrateLoadedState(state), false);
    assert.equal(state.servers[2].id, 'ok');
  });
});

describe('quoteWindowsToken (cmd.exe command line)', () => {
  it('quotes a command path containing spaces', () => {
    assert.equal(
      quoteWindowsToken('C:\\Users\\me\\AppData\\Local\\GitHub CLI\\extensions\\gh-mcp.exe'),
      '"C:\\Users\\me\\AppData\\Local\\GitHub CLI\\extensions\\gh-mcp.exe"',
    );
  });

  it('leaves a token without whitespace or quotes untouched', () => {
    assert.equal(quoteWindowsToken('npx'), 'npx');
    assert.equal(quoteWindowsToken('C:\\tools\\uvx.cmd'), 'C:\\tools\\uvx.cmd');
    assert.equal(quoteWindowsToken('-y'), '-y');
  });

  it('is idempotent for a token the user already quoted', () => {
    const quoted = '"C:\\path with space\\server.exe"';
    assert.equal(quoteWindowsToken(quoted), quoted);
    assert.equal(quoteWindowsToken(quoteWindowsToken(quoted)), quoted);
  });

  it('quotes an empty token and escapes inner quotes', () => {
    assert.equal(quoteWindowsToken(''), '""');
    assert.equal(quoteWindowsToken('say "hi"'), '"say \\"hi\\""');
  });

  it('produces the command line the issue reporter verified', () => {
    const command = quoteWindowsToken('C:\\path with space\\server.exe');
    const args = ['--flag', 'a b', 'plain'].map(quoteWindowsToken);
    assert.equal([command, ...args].join(' '), '"C:\\path with space\\server.exe" --flag "a b" plain');
  });
});
