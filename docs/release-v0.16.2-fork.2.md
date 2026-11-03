# v0.16.2-fork.2: edit workspace MCP proxies from Settings

Fork-only patch on top of v0.16.2-fork.1. That release added proxy resolution, but changing a proxy meant
hand-editing `.dsh/dshmm/mcp.local.json` and reloading the workspace. This release exposes both levels in
**Settings → MCP** without ever writing machine-specific values into the shared `mcp.json`.

## What changes

- The selected workspace card has a **local proxy** field. It writes the root `proxy` of
  `.dsh/dshmm/mcp.local.json`; clearing the input removes that key, and `direct` is stored as an empty
  string so it can mask a shared proxy. The card also states whether the value is local, inherited from
  the shared config, or unset.
- The edit form of an **HTTP** workspace server has a per-server proxy field. It writes
  `mcpServers[name].proxy` in the local overlay and displays the inherited value as a placeholder instead
  of copying it into a new override.
- A rename carries the whole local entry to the new name; deleting a server removes its local entry; and
  switching a server to stdio clears a stale local proxy that would otherwise make the merged entry invalid.
- Editing a server that has a hand-written proxy in the shared `mcp.json` preserves that value, because the
  form only owns the local overlay. Malformed proxy values are rejected with 400 before the base file is
  written.

## Verification

`node --test` — 219 tests, 0 failures. The new cases in `test/proxy.test.js` cover:

- local versus effective root proxy, direct round-trip, clearing the overlay file, and invalid values;
- per-server create/edit/rename/delete, explicit `direct`, clearing, and stdio rejection;
- preserving a shared proxy when the form sends an empty local field;
- dropping a local proxy when the server switches from http to stdio.
