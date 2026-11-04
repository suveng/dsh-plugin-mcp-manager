import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// dsh-client-modules keys every client row by *package name*, so a bundle that
// registers any other id is never registered and the whole plugin fails to boot
// ("loaded without registering ..."). Pin the two together.
it('client bundle registers under its package name', () => {
  let registeredId;
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          registeredId = id;
          factory(() => ({}));
        },
      },
    },
  });
  assert.equal(registeredId, manifest.name);
});
