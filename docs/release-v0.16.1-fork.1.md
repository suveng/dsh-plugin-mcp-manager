# v0.16.1-fork.1: configurable DCR client_name + registration-issued client secret

Fork-only patch on top of upstream v0.16.0 (`0f41abc`). It exists so that a provider which allowlists
`client_name` at its RFC 7591 registration endpoint (Figma) can complete the OAuth flow, and so that a
confidential client a registration hands back keeps working.

## Why

Discovery and authorization are fine; registration is the wall. Live probes on 2026-11-02 from the same
egress IP (no proxy, `mcp.figma.com` and `api.figma.com` metadata both 200):

- `POST https://api.figma.com/v1/oauth/mcp/register` with `client_name: "dsh-mcp-manager-figma"` →
  `403 Forbidden` (9-byte body, `x-cache: Error from cloudfront`).
- Replaying the identical request with only `client_name` changed:

| client_name | result |
|---|---|
| `Claude Code` | `200` — a fresh `client_id` **and** a `client_secret` for this registration |
| `Codex` / `Cline` / `GitHub Copilot CLI` | `400` — the name passes, another field does not |
| `Cursor` / `Claude` / `Zed` / `VS Code` / `Windsurf` / `Kiro` / `Amp` / `dsh` / `DeepSeek Harness` | `403` |

So the name is an allowlist, the secret is real, and no network change can help. Upstream already recorded
the same class of gate for Meta/WhatsApp (see `docs/release-v0.13.3.md`); there the endpoint returned one
*shared vendor* client id, which is why adopting a name was refused. Figma issues a distinct client per
registration, so a name override is only a label here.

## What changes

- `clientName` (Settings field, workspace `mcp.json` key, and internal `server.clientName`): the
  `client_name` sent to RFC 7591 registration. Empty keeps the historical `dsh-mcp-manager-<server>`.
  Validation (128 chars, no control characters) lives in `parseOauthFields`; `sameServerConfig` and both
  `*View` helpers carry it, and switching to `static`/`none`/stdio deletes it.
- `server.oauth.clientName` records the name a registration actually used. A changed `clientName`
  re-registers on the next authorization and keeps the token; the old client id is replaced in one step.
- `server.oauth.clientSecret` persists a `client_secret` returned by registration (0600 state file, never
  projected to the UI, attempt logs or messages). `clientSecretOf` prefers `clientSecretEnv` and falls
  back to it. A re-registration replaces or drops it, so a stale secret can never pair with a new id.

## Tests

`node --test test/oauth-dcr-client-name.test.js` — five cases against a stub whose `/register` accepts a
configurable name list and answers `403` otherwise, exactly like Figma: default name; configured name and
no re-registration while unchanged; secret persisted and sent on the authorization-code exchange *and* the
refresh that follows; re-registration when the name changes; invalid names rejected before any request.
Full suite: `npm test` → 205/205 pass.

## Install and revert

```sh
dsh plugin --profile web add github:suveng/dsh-mcp-manager#v0.16.1-fork.1 --store-dir=<profile store>
```

Once upstream ships an equivalent fix, install the upstream tag again and delete this document. The fork
carries no other behavioural change.
