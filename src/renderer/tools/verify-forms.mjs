// The permission model routes team requests through the main command composer.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
  '--config', 'src/renderer/tools/vitest.config.ts', 'src/renderer/src/components/permission-ui.test.ts',
  '-t', '6. requestChanges|6. snapshot|8. operations'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
