# v0.16.2-fork.1: per-server proxy support for workspace MCP servers

Fork-only patch on top of v0.16.1-fork.1. It exists because an MCP endpoint may be reachable only through
a proxy (corporate egress, or a link the operating system's direct route cannot carry) while DSH itself was
started without proxy environment variables: Node's global `fetch` ignores system proxy settings, so every
OAuth discovery, registration and JSON-RPC request failed with `fetch failed` / `ETIMEDOUT`.

## What changes

- `proxy` on a workspace server entry, a root `proxy` in `.dsh/dshmm/mcp.json`, or a root `proxy` in the
  machine-local overlay `.dsh/dshmm/mcp.local.json`. Resolution order: server entry → local overlay root →
  shared config root → `DSH_MCP_PROXY` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`/`http_proxy`.
- `"proxy": "direct"` (also `none`, `off`, `false`, `""`) bypasses the proxy for one server.
- Malformed values (wrong scheme, path/query present) become a workspace error instead of a silent direct
  connection; a stdio entry that declares `proxy` is rejected, because a pipe has nothing to proxy.
- `mcp.local.json` is merged over `mcp.json`: per-server fields merge, `disabled` / `exclude` are unioned
  (the overlay may add restrictions, never lift a team-wide one), and both files are watched for changes.
- Discovery (`fetchJson`) retries transient failures (network errors, 429, 5xx) up to three times with a
  250ms/500ms backoff instead of falling back to guessed endpoints on the first timeout. A 4xx is final.
- Proxied requests use the `undici` package's `fetch` with a `ProxyAgent`; unproxied requests keep Node's
  global `fetch`, so nothing changes for profiles that do not configure a proxy. `undici` is now a declared
  dependency (bundled into the installed package).

## Why `proxyTunnel: false`

`ProxyAgent` defaults to CONNECT even for plain-http targets, which makes a proxy that only speaks
forward-proxy semantics (absolute-form request line) hang until the request times out. With
`proxyTunnel: false` an `http://` target is sent as `POST http://host/mcp HTTP/1.1` through the proxy
(browser behaviour), while `https://` targets still tunnel with CONNECT because TLS has to be end to end.
Verified against a loopback forward proxy in `test/proxy.test.js`.

## Verification

`node --test` — 214 tests, 0 failures, including `test/proxy.test.js`:

- value normalization (including `direct`, credentials, rejected `socks5://` / path / query);
- environment precedence and explicit opt-out;
- overlay merge semantics (fields, `disabled` / `exclude` union, base object untouched);
- end-to-end workspace connections through a loopback proxy declared in the shared config and in the
  overlay, a per-server opt-out, configuration errors, and discovery retrying two 503s before succeeding.
