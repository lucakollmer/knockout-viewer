import { spawnSync } from 'node:child_process';

const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const REPO = 'lucakollmer/knockout-viewer';
const branch = process.env.WORKERS_CI_BRANCH || '';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const credential = spawnSync('git', ['credential', 'fill'], {
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (credential.status === 0) {
    const fields = Object.fromEntries(credential.stdout.trim().split('\n').map((line) => {
      const split = line.indexOf('=');
      return split >= 0 ? [line.slice(0, split), line.slice(split + 1)] : [line, ''];
    }));
    if (fields.password) return fields.password;
  }
  const remote = run('git', ['remote', 'get-url', 'origin']);
  if (remote.status === 0) {
    try {
      const url = new URL(remote.stdout.trim());
      if (url.hostname === 'github.com' && url.password) return decodeURIComponent(url.password);
    } catch {}
  }
  return null;
}

async function github(path, token, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cloudflare-benchmark-mirror',
      ...(init.headers || {}),
    },
  });
}

if (process.env.WORKERS_CI !== '1' || !branch || branch === 'main') process.exit(0);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const kv = run(npx, [
  'wrangler', 'kv', 'key', 'get', 'knockout:latest',
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
]);
if (kv.status !== 0 || !kv.stdout.trim()) {
  console.log('[benchmark-mirror] KV read unavailable.');
  process.exit(0);
}

let record;
try { record = JSON.parse(kv.stdout); }
catch {
  console.log('[benchmark-mirror] KV value is not valid JSON.');
  process.exit(0);
}
if (record?.schema !== 'knockout-asets.benchmark/v1' || typeof record?.run_id !== 'string') {
  console.log('[benchmark-mirror] latest KV value is not an Asets benchmark.');
  process.exit(0);
}

const token = githubToken();
if (!token) {
  console.log('[benchmark-mirror] GitHub checkout credential is not exposed to the build.');
  process.exit(0);
}

const pullsResponse = await github(`/repos/${REPO}/pulls?state=open&head=lucakollmer%3A${encodeURIComponent(branch)}`, token);
if (!pullsResponse.ok) {
  console.log(`[benchmark-mirror] unable to resolve PR (${pullsResponse.status}).`);
  process.exit(0);
}
const pulls = await pullsResponse.json();
const pr = pulls[0];
if (!pr?.number) {
  console.log('[benchmark-mirror] no open PR found for branch.');
  process.exit(0);
}

const marker = `<!-- knockout-asets-benchmark:${record.run_id} -->`;
const commentsResponse = await github(`/repos/${REPO}/issues/${pr.number}/comments?per_page=100`, token);
if (commentsResponse.ok) {
  const comments = await commentsResponse.json();
  if (comments.some((comment) => typeof comment?.body === 'string' && comment.body.includes(marker))) {
    console.log(`[benchmark-mirror] run ${record.run_id} already mirrored to PR #${pr.number}.`);
    process.exit(0);
  }
}

let payload = record;
let serialized = JSON.stringify(payload, null, 2);
if (serialized.length > 55000) {
  payload = {
    schema: record.schema,
    run_id: record.run_id,
    started_at: record.started_at,
    completed_at: record.completed_at,
    deployment: record.deployment,
    client: record.client,
    benchmark: record.benchmark,
    server_received_at: record.server_received_at,
    benchmark_record_id: record.benchmark_record_id,
  };
  serialized = JSON.stringify(payload, null, 2);
}
if (serialized.length > 55000) {
  console.log('[benchmark-mirror] benchmark payload too large for a PR comment.');
  process.exit(0);
}

const body = `${marker}\n### Asets browser benchmark upload\n\n\`\`\`json\n${serialized}\n\`\`\``;
const post = await github(`/repos/${REPO}/issues/${pr.number}/comments`, token, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ body }),
});
if (!post.ok) {
  console.log(`[benchmark-mirror] GitHub comment write unavailable (${post.status}).`);
  process.exit(0);
}
console.log(`[benchmark-mirror] mirrored run ${record.run_id} to PR #${pr.number}.`);
