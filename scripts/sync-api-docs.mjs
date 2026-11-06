import fs from 'node:fs';
// Upstream checks in a symlink. macOS cp rejects copying a file onto itself.
const source = new URL('../server/openapi.yaml', import.meta.url);
const target = new URL('../public/api-docs/openapi.yaml', import.meta.url);
if (!fs.existsSync(target) || fs.realpathSync(source) !== fs.realpathSync(target)) {
  fs.copyFileSync(source, target);
}
