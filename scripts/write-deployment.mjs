import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('public', { recursive: true });
const marker = {
  sha: process.env.WORKERS_CI_COMMIT_SHA ?? 'local',
  branch: process.env.WORKERS_CI_BRANCH ?? 'local',
  buildUuid: process.env.WORKERS_CI_BUILD_UUID ?? null,
};
await writeFile('public/deployment.json', `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
