import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// Pin the home before importing the plugin: STATE_PATH is derived at load time.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-dcr-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));
assert.equal(homedir(), scratchHome, 'homedir() must resolve to the scratch home');
mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'dsh-plugin-mcp-manager.json');

const { apply } = await import('../lib/index.js');

function makeCtx(config = {}) {
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({
          webServer: ctx.webServer,
          get: () => undefined,
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
        });
      }
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  apply(ctx, config);
  return { routes, handler: routes[0]?.handler };
}

async function request(handler, method, path, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ?? ''; },
  };
  await handler(req, res);
  let json;
  try { json = res.body ? JSON.parse(res.body) : undefined; } catch {}
  return { code: res.code, json, text: String(res.body) };
}

/**
 * Stub provider that behaves like Figma's registration endpoint: only one
 * first-party client_name is accepted, and a confidential client (client_id +
 * client_secret) comes back even though token_endpoint_auth_method "none" was
 * requested. A rejected name answers 403, like Figma.
 */
function startStub({ acceptedNames = ['Claude Code'], issueSecret = 'dcr-secret' } = {}) {
  const registrations = [];
  const forms = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const base = 'http://127.0.0.1:' + server.address().port;
      if (req.url === '/mcp') {
        return send(401, { error: 'unauthorized' }, {
          'WWW-Authenticate': 'Bearer error="invalid_request", resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"',
        });
      }
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        return send(200, { resource: base + '/mcp', authorization_servers: [base] });
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        return send(200, {
          issuer: base,
          authorization_endpoint: base + '/authorize',
          token_endpoint: base + '/token',
          registration_endpoint: base + '/register',
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
      }
      if (req.url === '/register') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        registrations.push(payload);
        if (!acceptedNames.includes(payload.client_name)) return send(403, 'Forbidden');
        return send(200, { client_id: 'dcr-client', client_secret: issueSecret, redirect_uris: payload.redirect_uris });
      }
      if (req.url === '/token') {
        forms.push(new URLSearchParams(raw));
        return send(200, { access_token: 'example-access-token', refresh_token: 'example-refresh-token', token_type: 'bearer', expires_in: 3600 });
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      resolve({
        base,
        mcpUrl: base + '/mcp',
        registrations,
        forms,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

const state = () => JSON.parse(readFileSync(statePath, 'utf8'));

// One state file per process, and the manager rejects duplicate names: every
// server needs its own.
let seq = 0;
const nextName = () => 'figma-' + (++seq);

async function authorize(t, extra = {}, stubOptions = {}) {
  const stub = await startStub(stubOptions);
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers', { name: nextName(), type: 'http', url: stub.mcpUrl, ...extra });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  t.after(() => request(handler, 'DELETE', '/dsh-plugin-mcp-manager/api/servers/' + id));
  const auth = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers/' + id + '/auth');
  return { stub, handler, id, auth };
}

it('default registration name stays dsh-plugin-mcp-manager-<server>', async (t) => {
  const name = nextName();
  const stub = await startStub({ acceptedNames: ['dsh-plugin-mcp-manager-' + name] });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers', { name, type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const auth = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers/' + created.json.server.id + '/auth');
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations[0].client_name, 'dsh-plugin-mcp-manager-' + name);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('client_id'), 'dcr-client');
});

it('honours a configured clientName and reuses the registration while unchanged', async (t) => {
  const { stub, handler, id, auth } = await authorize(t, { clientName: 'Claude Code' });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 1);
  assert.equal(stub.registrations[0].client_name, 'Claude Code');
  assert.equal(state().servers.find((server) => server.id === id).oauth.clientName, 'Claude Code');
  const again = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers/' + id + '/auth');
  assert.equal(again.code, 200, again.text);
  assert.equal(stub.registrations.length, 1, 'same name and redirect must not re-register');
});

it('persists the registration secret and presents it at token exchange only', async (t) => {
  const { stub, handler, id, auth } = await authorize(t, { clientName: 'Claude Code' });
  assert.equal(auth.code, 200, auth.text);
  const authorizeUrl = new URL(auth.json.authorizeUrl);
  const callback = await request(handler, 'GET',
    '/dsh-plugin-mcp-manager/callback/' + id + '?code=synthetic-code&state=' + authorizeUrl.searchParams.get('state'));
  assert.match(callback.text, /Authorized/);
  const exchanges = stub.forms.filter((form) => form.get('grant_type') === 'authorization_code');
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].get('client_id'), 'dcr-client');
  assert.equal(exchanges[0].get('client_secret'), 'dcr-secret');
  // 回调后连接会触发一次 refresh_token 兑换：它同样必须带上注册时拿到的 secret。
  for (const form of stub.forms) {
    assert.equal(form.get('client_secret'), 'dcr-secret', 'every token request must authenticate the confidential client');
  }
  assert.equal(state().servers.find((server) => server.id === id).oauth.clientSecret, 'dcr-secret');
  const view = await request(handler, 'GET', '/dsh-plugin-mcp-manager/api/servers');
  const projected = view.json.servers.find((server) => server.id === id);
  assert.equal(projected.clientName, 'Claude Code');
  assert.equal(projected.oauth.clientSecret, undefined);
  assert.equal(JSON.stringify(view.json).includes('dcr-secret'), false, 'secret must stay out of the UI projection');
});

it('re-registers when clientName changes', async (t) => {
  const { stub, handler, id } = await authorize(t, { clientName: 'Claude Code' }, { acceptedNames: ['Claude Code', 'Other Client'] });
  const renamed = await request(handler, 'PUT', '/dsh-plugin-mcp-manager/api/servers/' + id,
    { name: 'renamed-' + id, type: 'http', url: stub.mcpUrl, clientName: 'Other Client' });
  assert.equal(renamed.code, 200, renamed.text);
  const auth = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers/' + id + '/auth');
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 2);
  assert.equal(stub.registrations[1].client_name, 'Other Client');
});

it('rejects an unusable clientName instead of sending it', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const tooLong = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers', { name: nextName(), type: 'http', url: stub.mcpUrl, clientName: 'x'.repeat(129) });
  assert.equal(tooLong.code, 400, tooLong.text);
  const control = await request(handler, 'POST', '/dsh-plugin-mcp-manager/api/servers', { name: nextName(), type: 'http', url: stub.mcpUrl, clientName: 'bad\u0001name' });
  assert.equal(control.code, 400, control.text);
  assert.equal(stub.registrations.length, 0);
});

it('reads clientName from a workspace mcp.json and projects it', async (t) => {
  const dir = join(scratchHome, 'ws-figma');
  mkdirSync(join(dir, '.dsh/dshmm'), { recursive: true });
  const name = 'figma-ws-' + nextName();
  writeFileSync(join(dir, '.dsh/dshmm/mcp.json'), JSON.stringify({
    mcpServers: { [name]: { type: 'http', url: 'https://mcp.figma.com/mcp', authMode: 'oauth', clientName: 'Claude Code' } },
  }, null, 2));
  let handler;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    get: (service) => service === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined,
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    inject: (names, callback) => {
      callback({
        webServer: { register: (route) => { handler = route.handler; return () => {}; } },
        effect: (fn) => fn(),
        get: () => undefined,
      });
      return { dispose: () => {} };
    },
  };
  apply(ctx, {});
  const listed = await request(handler, 'GET', '/dsh-plugin-mcp-manager/api/workspaces');
  assert.equal(listed.code, 200, listed.text);
  const entry = listed.json.workspaces.find((workspace) => workspace.path === dir).servers.find((server) => server.name === name);
  assert.equal(entry.clientName, 'Claude Code');
});
