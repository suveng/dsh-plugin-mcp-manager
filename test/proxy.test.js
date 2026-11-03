import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// Isolate persisted state and drop any proxy inherited from the developer's
// shell: the environment must not leak into these assertions.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-proxy-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = scratch;
const PROXY_ENV = ['DSH_MCP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
for (const name of PROXY_ENV) delete process.env[name];
const { apply, envProxyValue, mergeWorkspaceConfig, normalizeProxyValue, proxyForServer } = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 5500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  assert.ok(await fn(), 'condition did not become true');
}

// Minimal streamable-HTTP MCP endpoint: initialize, tools/list, anything else
// answers like a tool result. Enough for the plugin to project a tool.
async function mcpEndpoint() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const msg = JSON.parse(body);
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Forward proxy for plain http targets: the client sends the absolute URL in
// the request line, which is both what we replay upstream and what we assert on.
async function forwardProxy() {
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if (req.method === 'CONNECT') { res.writeHead(405); res.end(); return; }
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const upstream = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    stop: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

function mount(t, { mcp, local }) {
  const dir = mkdtempSync(join(scratch, 'ws-'));
  mkdirSync(join(dir, '.dsh/dshmm'), { recursive: true });
  writeFileSync(join(dir, '.dsh/dshmm/mcp.json'), JSON.stringify(mcp));
  if (local) writeFileSync(join(dir, '.dsh/dshmm/mcp.local.json'), JSON.stringify(local));
  mkdirSync(join(scratch, '.dsh'), { recursive: true });
  writeFileSync(join(scratch, '.dsh/dsh-plugin-mcp-manager.json'), JSON.stringify({ servers: [] }));
  const cleanup = [];
  const registered = new Map();
  const registry = {
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    restrict: () => () => {}, execute: async () => ({}),
  };
  const agent = { session: { header: { cwd: dir } }, ctx: { tools: registry } };
  // The plugin decorates both methods and bails out (disabling workspace
  // scoping) unless both exist, so the fake provides create and resume.
  const agents = {
    create: options => options.setup({ effect: fn => { cleanup.push(fn()); } }, agent),
    resume: options => options.setup({ effect: fn => { cleanup.push(fn()); } }, agent),
  };
  let handler;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} }, tools: registry,
    get: name => name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined,
    on: () => () => {}, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; },
    inject: (names, callback) => { callback({ agents, webServer: { register: route => { handler = route.handler; return () => {}; } }, effect: fn => { cleanup.push(fn()); } }); return { dispose() {} }; },
  };
  apply(ctx);
  t.after(() => { for (const fn of cleanup.reverse()) fn(); });
  const api = async (method, suffix, body) => {
    const req = { method, url: `/dsh-plugin-mcp-manager/api${suffix}`, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    let code, data;
    await handler(req, { writeHead(value) { code = value; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
    return { code, ...data };
  };
  const workspace = async () => (await api('GET', '/workspaces')).workspaces.find(ws => ws.path === dir);
  return { dir, api, workspace, registered, attach: () => agents.create({}), view: async () => (await workspace()).servers[0] };
}

it('normalizes proxy values, including explicit direct and rejected forms', () => {
  assert.equal(normalizeProxyValue(undefined), undefined);
  assert.equal(normalizeProxyValue(null), undefined);
  assert.equal(normalizeProxyValue(false), '');
  assert.equal(normalizeProxyValue(''), '');
  assert.equal(normalizeProxyValue('   '), '');
  for (const off of ['none', 'DIRECT', 'off']) assert.equal(normalizeProxyValue(off), '');
  assert.equal(normalizeProxyValue('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyValue('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyValue(' https://user:p%40ss@proxy.local:8443 '), 'https://user:p%40ss@proxy.local:8443');
  assert.equal(normalizeProxyValue('http://user@proxy.local:8080'), 'http://user@proxy.local:8080');
  assert.throws(() => normalizeProxyValue('127.0.0.1:7890'), /invalid proxy/);
  assert.throws(() => normalizeProxyValue('socks5://127.0.0.1:1080'), /only http/);
  assert.throws(() => normalizeProxyValue('http://proxy.local:8080/path'), /path, query or fragment/);
  assert.throws(() => normalizeProxyValue('http://proxy.local:8080?x=1'), /path, query or fragment/);
});

it('reads the environment in precedence order and skips unusable values', () => {
  const saved = Object.fromEntries(PROXY_ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of PROXY_ENV) delete process.env[name];
    assert.equal(envProxyValue(), '');
    process.env.HTTP_PROXY = 'http://127.0.0.1:1111';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:2222';
    assert.equal(envProxyValue(), 'http://127.0.0.1:2222');
    process.env.DSH_MCP_PROXY = 'socks5://127.0.0.1:1080';
    assert.equal(envProxyValue(), 'http://127.0.0.1:2222');
    process.env.DSH_MCP_PROXY = 'http://127.0.0.1:3333';
    assert.equal(envProxyValue(), 'http://127.0.0.1:3333');
    assert.equal(proxyForServer({ proxy: '' }), '', 'an explicit direct setting beats the environment');
    assert.equal(proxyForServer({}), 'http://127.0.0.1:3333');
    assert.equal(proxyForServer({ proxy: 'http://127.0.0.1:4444' }), 'http://127.0.0.1:4444');
  } finally {
    for (const name of PROXY_ENV) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});

it('merges the machine-local overlay without letting it lift shared restrictions', () => {
  const base = {
    mcpServers: { alpha: { type: 'http', url: 'http://alpha', clientName: 'Claude Code' }, beta: { type: 'stdio', command: 'npx' } },
    disabled: ['alpha'], exclude: ['global'],
  };
  const local = {
    proxy: 'http://127.0.0.1:7890',
    mcpServers: { alpha: { proxy: 'http://127.0.0.1:7891' }, gamma: { type: 'http', url: 'http://gamma' } },
    disabled: ['beta', ''], exclude: ['other'],
  };
  const merged = mergeWorkspaceConfig(base, local);
  assert.equal(merged.proxy, 'http://127.0.0.1:7890');
  assert.deepEqual(merged.mcpServers.alpha, { type: 'http', url: 'http://alpha', clientName: 'Claude Code', proxy: 'http://127.0.0.1:7891' });
  assert.deepEqual(merged.mcpServers.beta, { type: 'stdio', command: 'npx' });
  assert.deepEqual(merged.mcpServers.gamma, { type: 'http', url: 'http://gamma' });
  assert.deepEqual(merged.disabled, ['alpha', 'beta']);
  assert.deepEqual(merged.exclude, ['global', 'other']);
  assert.equal(base.proxy, undefined, 'the shared config object is not mutated');
});

it('routes a workspace server through the proxy declared in the shared config', async t => {
  const remote = await mcpEndpoint(); t.after(remote.stop);
  const proxy = await forwardProxy(); t.after(proxy.stop);
  const h = mount(t, { mcp: { proxy: proxy.url, mcpServers: { local: { type: 'http', url: remote.url, authMode: 'none' } } } });
  await h.attach();
  await until(() => h.registered.has('mcp__local__echo'));
  assert.equal((await h.view()).status, 'connected');
  assert.ok(proxy.seen.length >= 1, 'the MCP request must reach the proxy');
  assert.ok(proxy.seen.every(entry => entry.url === remote.url), `unexpected proxy target: ${JSON.stringify(proxy.seen)}`);
});

it('accepts the proxy from the gitignored machine-local overlay', async t => {
  const remote = await mcpEndpoint(); t.after(remote.stop);
  const proxy = await forwardProxy(); t.after(proxy.stop);
  const h = mount(t, {
    mcp: { mcpServers: { local: { type: 'http', url: remote.url, authMode: 'none' } } },
    local: { proxy: proxy.url },
  });
  await h.attach();
  await until(() => h.registered.has('mcp__local__echo'));
  assert.equal((await h.view()).status, 'connected');
  assert.ok(proxy.seen.length >= 1, 'the overlay proxy must be used');
});

it('lets one server opt out of the workspace-wide proxy', async t => {
  const remote = await mcpEndpoint(); t.after(remote.stop);
  const proxy = await forwardProxy(); t.after(proxy.stop);
  const h = mount(t, {
    mcp: {
      proxy: proxy.url,
      mcpServers: {
        local: { type: 'http', url: `${remote.url}?tag=proxied`, authMode: 'none' },
        direct: { type: 'http', url: `${remote.url}?tag=direct`, authMode: 'none', proxy: 'direct' },
      },
    },
  });
  await h.attach();
  await until(() => h.registered.has('mcp__local__echo') && h.registered.has('mcp__direct__echo'));
  assert.ok(proxy.seen.some(entry => entry.url.includes('tag=proxied')));
  assert.ok(!proxy.seen.some(entry => entry.url.includes('tag=direct')), 'an explicit direct server must bypass the proxy');
});

it('reports configuration mistakes instead of silently connecting directly', async t => {
  const stdio = mount(t, { mcp: { mcpServers: { bad: { type: 'stdio', command: 'node', proxy: 'http://127.0.0.1:7890' } } } });
  await stdio.attach();
  assert.match((await stdio.workspace()).error, /"proxy" is only supported for http servers/);

  const malformed = mount(t, { mcp: { proxy: 'socks5://127.0.0.1:1080', mcpServers: {} } });
  await malformed.attach();
  assert.match((await malformed.workspace()).error, /invalid proxy/);
});

// Discovery used to give up on the first transient failure and fall back to
// guessed endpoints; two 503s must still end in the discovered authorization URL.
async function oauthStub() {
  let resourceHits = 0;
  let clientName = '';
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      resourceHits += 1;
      if (resourceHits <= 2) { res.writeHead(503); res.end('temporarily unavailable'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        clientName = JSON.parse(body).client_name;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ client_id: 'cid-test' }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    origin: base,
    hits: () => resourceHits,
    clientName: () => clientName,
    stop: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

it('retries transient discovery failures before falling back', async t => {
  const stub = await oauthStub(); t.after(stub.stop);
  const h = mount(t, { mcp: { mcpServers: { oauth: { type: 'http', url: `${stub.origin}/mcp`, authMode: 'oauth' } } } });
  await h.attach();
  const auth = await h.api('POST', '/workspaces/auth', { path: h.dir, name: 'oauth' });
  assert.equal(auth.code, 200);
  assert.ok(auth.authorizeUrl.startsWith(`${stub.origin}/authorize`), auth.authorizeUrl);
  assert.match(auth.authorizeUrl, /client_id=cid-test/);
  assert.equal(stub.hits(), 3, 'two 503s then a 200');
  assert.equal(stub.clientName(), 'dsh-plugin-mcp-manager-oauth');
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const localPath = (dir) => join(dir, '.dsh/dshmm/mcp.local.json');
const basePath = (dir) => join(dir, '.dsh/dshmm/mcp.json');

it('reports the local proxy override separately from the effective proxy', async t => {
  const h = mount(t, {
    mcp: {
      proxy: 'http://127.0.0.1:7801',
      mcpServers: {
        alpha: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        beta: { type: 'http', url: 'http://127.0.0.1:2/mcp' },
      },
    },
    local: { mcpServers: { beta: { proxy: 'direct' } } },
  });
  const ws = await h.workspace();
  assert.equal(ws.proxy, '', 'the root input shows only the local override');
  assert.equal(ws.proxyLocal, false);
  assert.equal(ws.proxyEffective, 'http://127.0.0.1:7801');
  const alpha = ws.servers.find(s => s.name === 'alpha');
  assert.equal(alpha.proxy, '');
  assert.equal(alpha.proxyLocal, false);
  assert.equal(alpha.proxyEffective, 'http://127.0.0.1:7801');
  assert.equal(alpha.proxyInherited, true);
  const beta = ws.servers.find(s => s.name === 'beta');
  assert.equal(beta.proxy, '', 'direct is a real local value, not "unset"');
  assert.equal(beta.proxyLocal, true);
  assert.equal(beta.proxyEffective, '');
  assert.equal(beta.proxyInherited, false);
});

it('writes the workspace proxy into the local overlay and clears it again', async t => {
  const h = mount(t, { mcp: { mcpServers: { alpha: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } });
  const set = await h.api('POST', '/workspaces/proxy', { path: h.dir, proxy: 'http://127.0.0.1:7893/' });
  assert.equal(set.code, 200);
  assert.deepEqual(readJson(localPath(h.dir)), { proxy: 'http://127.0.0.1:7893' });
  let ws = await h.workspace();
  assert.equal(ws.proxy, 'http://127.0.0.1:7893');
  assert.equal(ws.proxyLocal, true);
  assert.equal(ws.servers[0].proxyEffective, 'http://127.0.0.1:7893');

  const cleared = await h.api('POST', '/workspaces/proxy', { path: h.dir, proxy: '' });
  assert.equal(cleared.code, 200);
  assert.equal(existsSync(localPath(h.dir)), false, 'an emptied overlay must not stay on disk');
  ws = await h.workspace();
  assert.equal(ws.proxy, '');
  assert.equal(ws.proxyEffective, '');

  const directRoot = await h.api('POST', '/workspaces/proxy', { path: h.dir, proxy: 'direct' });
  assert.equal(directRoot.code, 200);
  assert.equal(readJson(localPath(h.dir)).proxy, '');
  ws = await h.workspace();
  assert.equal(ws.proxy, 'direct', 'an explicit direct root override must round-trip into the form');
  assert.equal(ws.proxyLocal, true);
  assert.equal(ws.proxyEffective, '');

  const bad = await h.api('POST', '/workspaces/proxy', { path: h.dir, proxy: 'socks5://127.0.0.1:1080' });
  assert.equal(bad.code, 400);
  assert.match(bad.error, /only http/);
  const missing = await h.api('POST', '/workspaces/proxy', { path: h.dir });
  assert.equal(missing.code, 400);
});

it('edits a per-server proxy through the local overlay without touching mcp.json', async t => {
  const h = mount(t, { mcp: { mcpServers: { alpha: { type: 'http', url: 'http://127.0.0.1:1/mcp', authMode: 'none' } } } });
  const created = await h.api('POST', '/workspaces/servers', {
    path: h.dir, name: 'beta', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none', proxy: 'http://127.0.0.1:7894',
  });
  assert.equal(created.code, 200);
  assert.equal(readJson(basePath(h.dir)).mcpServers.beta.proxy, undefined, 'mcp.json must stay machine-independent');
  assert.equal(readJson(localPath(h.dir)).mcpServers.beta.proxy, 'http://127.0.0.1:7894');
  let beta = (await h.workspace()).servers.find(s => s.name === 'beta');
  assert.equal(beta.proxy, 'http://127.0.0.1:7894');
  assert.equal(beta.proxyLocal, true);

  const renamed = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'beta', name: 'gamma', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none',
  });
  assert.equal(renamed.code, 200);
  const afterRename = readJson(localPath(h.dir));
  assert.equal(afterRename.mcpServers.beta, undefined);
  assert.equal(afterRename.mcpServers.gamma.proxy, 'http://127.0.0.1:7894', 'a rename must carry the local proxy');

  const direct = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'gamma', name: 'gamma', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none', proxy: 'direct',
  });
  assert.equal(direct.code, 200);
  assert.equal(readJson(localPath(h.dir)).mcpServers.gamma.proxy, '');
  const gamma = (await h.workspace()).servers.find(s => s.name === 'gamma');
  assert.equal(gamma.proxyLocal, true);
  assert.equal(gamma.proxyEffective, '');

  const cleared = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'gamma', name: 'gamma', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none', proxy: '',
  });
  assert.equal(cleared.code, 200);
  assert.equal(existsSync(localPath(h.dir)), false, 'clearing the only local entry removes the overlay file');
  assert.ok(readJson(basePath(h.dir)).mcpServers.gamma, 'the base entry itself stays');

  const removed = await h.api('POST', '/workspaces/servers/delete', { path: h.dir, name: 'gamma' });
  assert.equal(removed.code, 200);
  assert.equal(readJson(basePath(h.dir)).mcpServers.gamma, undefined);

  const bad = await h.api('POST', '/workspaces/servers', {
    path: h.dir, name: 'cmd', type: 'stdio', command: 'npx', proxy: 'http://127.0.0.1:7895',
  });
  assert.equal(bad.code, 400);
  assert.match(bad.error, /only supported for http/);
});

it('drops a local proxy when a server switches to stdio', async t => {
  const h = mount(t, { mcp: { mcpServers: {} } });
  const created = await h.api('POST', '/workspaces/servers', {
    path: h.dir, name: 'beta', type: 'http', url: 'http://127.0.0.1:1/mcp', authMode: 'none', proxy: 'http://127.0.0.1:7896',
  });
  assert.equal(created.code, 200);
  assert.equal(readJson(localPath(h.dir)).mcpServers.beta.proxy, 'http://127.0.0.1:7896');

  const switched = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'beta', name: 'beta', type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'],
  });
  assert.equal(switched.code, 200);
  assert.equal(readJson(basePath(h.dir)).mcpServers.beta.proxy, undefined);
  assert.equal(existsSync(localPath(h.dir)), false, 'a stdio server must not keep a stale local proxy');
  assert.ok(readJson(basePath(h.dir)).mcpServers.beta, 'the base stdio entry stays');
});

it('keeps a hand-written shared proxy when an edit omits the proxy field', async t => {
  const h = mount(t, { mcp: { mcpServers: { alpha: { type: 'http', url: 'http://127.0.0.1:1/mcp', proxy: 'http://127.0.0.1:7005' } } } });
  const res = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'alpha', name: 'alpha', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none',
  });
  assert.equal(res.code, 200);
  assert.equal(readJson(basePath(h.dir)).mcpServers.alpha.proxy, 'http://127.0.0.1:7005');
  const alpha = (await h.workspace()).servers[0];
  assert.equal(alpha.proxyEffective, 'http://127.0.0.1:7005');
  assert.equal(alpha.proxyLocal, false);

  // The form always sends its (empty) local field. Clearing the local override
  // must still not strip the shared proxy out of mcp.json.
  const formEdit = await h.api('PUT', '/workspaces/servers', {
    path: h.dir, oldName: 'alpha', name: 'alpha', type: 'http', url: 'http://127.0.0.1:2/mcp', authMode: 'none', proxy: '',
  });
  assert.equal(formEdit.code, 200);
  assert.equal(readJson(basePath(h.dir)).mcpServers.alpha.proxy, 'http://127.0.0.1:7005');
  assert.equal(existsSync(localPath(h.dir)), false);
});
