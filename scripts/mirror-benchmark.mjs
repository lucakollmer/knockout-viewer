import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const REPO = 'lucakollmer/knockout-viewer';
const TARGET_PATH = 'benchmarks/MIRROR_TRIGGER.md';
const OUTPUT_PATH = 'benchmarks/latest-browser-summary.json';
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

function compactScenario(scenario) {
  const performance = scenario?.performance;
  return {
    id: scenario?.id ?? null,
    profile: scenario?.profile ?? null,
    r: scenario?.r ?? null,
    residues: scenario?.residues ?? null,
    wall_ms: scenario?.wall_ms ?? null,
    first_message_ms: scenario?.first_message_ms ?? null,
    first_chunk_ms: scenario?.first_chunk_ms ?? null,
    records_received: scenario?.records_received ?? null,
    timed_out: Boolean(scenario?.timed_out),
    cancelled: Boolean(scenario?.cancelled),
    error: scenario?.error ?? null,
    main_thread_delay_p95_ms: scenario?.main_thread_delay_p95_ms ?? null,
    main_thread_delay_max_ms: scenario?.main_thread_delay_max_ms ?? null,
    performance: performance ? {
      modulusContextMs: performance.modulusContextMs ?? null,
      cspMs: performance.cspMs ?? null,
      geometryMs: performance.geometryMs ?? null,
      totalWorkerComputeMs: performance.totalWorkerComputeMs ?? null,
      serializationMs: performance.serializationMs ?? null,
      indexedDbReadMs: performance.indexedDbReadMs ?? null,
      indexedDbWriteMs: performance.indexedDbWriteMs ?? null,
      cacheHit: performance.cacheHit ?? null,
    } : null,
  };
}

if (process.env.WORKERS_CI !== '1' || !branch || branch === 'main') process.exit(0);

let targetText = '';
try { targetText = readFileSync(TARGET_PATH, 'utf8'); } catch {}
const targetMatch = targetText.match(/Target SHA:\s*([0-9a-f]{40})/i);
if (!targetMatch) {
  console.log('[benchmark-mirror] no exact target SHA requested.');
  process.exit(0);
}
const targetSha = targetMatch[1].toLowerCase();

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const kv = run(npx, [
  'wrangler', 'kv', 'key', 'get', `knockout:latest:${targetSha}`,
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
]);
if (kv.status !== 0 || !kv.stdout.trim()) {
  console.log(`[benchmark-mirror] exact KV read unavailable for ${targetSha}.`);
  process.exit(0);
}

let record;
try { record = JSON.parse(kv.stdout); }
catch {
  console.log('[benchmark-mirror] KV value is not valid JSON.');
  process.exit(0);
}
if (
  record?.schema !== 'knockout-asets.benchmark/v1'
  || typeof record?.run_id !== 'string'
  || record?.deployment?.sha !== targetSha
) {
  console.log('[benchmark-mirror] KV record does not match requested Asets benchmark SHA.');
  process.exit(0);
}

const summary = {
  schema: 'knockout-asets.benchmark-summary/v1',
  target_sha: targetSha,
  run_id: record.run_id,
  started_at: record.started_at ?? null,
  completed_at: record.completed_at ?? null,
  server_received_at: record.server_received_at ?? null,
  benchmark_record_id: record.benchmark_record_id ?? null,
  deployment: record.deployment,
  client: record.client ?? null,
  benchmark: {
    suite: record.benchmark?.suite ?? null,
    harness_version: record.benchmark?.harness_version ?? null,
    benchmark_kind: record.benchmark?.benchmark_kind ?? null,
    case_timeout_ms: record.benchmark?.case_timeout_ms ?? null,
    frontier: record.benchmark?.frontier ?? null,
    dimension_semantics: record.benchmark?.dimension_semantics ?? null,
    scenarios: Array.isArray(record.benchmark?.scenarios)
      ? record.benchmark.scenarios.map(compactScenario)
      : [],
  },
};
const serialized = JSON.stringify(summary, null, 2);
console.log(`[benchmark-mirror] exact summary ready (${serialized.length} bytes) for ${targetSha}.`);

const token = githubToken();
if (token) {
  try {
    const pullsResponse = await github(`/repos/${REPO}/pulls?state=open&head=lucakollmer%3A${encodeURIComponent(branch)}`, token);
    if (pullsResponse.ok) {
      const pulls = await pullsResponse.json();
      const pr = pulls[0];
      if (pr?.number) {
        const marker = `<!-- knockout-asets-benchmark-summary:${targetSha}:${record.run_id} -->`;
        const commentsResponse = await github(`/repos/${REPO}/issues/${pr.number}/comments?per_page=100`, token);
        let alreadyPresent = false;
        if (commentsResponse.ok) {
          const comments = await commentsResponse.json();
          alreadyPresent = comments.some((comment) => typeof comment?.body === 'string' && comment.body.includes(marker));
        }
        if (!alreadyPresent) {
          const body = `${marker}\n### Asets benchmark exact-SHA summary\n\n\`\`\`json\n${serialized}\n\`\`\``;
          const post = await github(`/repos/${REPO}/issues/${pr.number}/comments`, token, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body }),
          });
          if (post.ok) {
            console.log(`[benchmark-mirror] posted exact summary to PR #${pr.number}.`);
            process.exit(0);
          }
          console.log(`[benchmark-mirror] PR comment write unavailable (${post.status}); trying git push.`);
        } else {
          console.log(`[benchmark-mirror] exact summary already present on PR #${pr.number}.`);
          process.exit(0);
        }
      }
    }
  } catch (error) {
    console.log(`[benchmark-mirror] PR comment path failed: ${String(error?.message || error)}`);
  }
} else {
  console.log('[benchmark-mirror] no GitHub REST credential; trying git push.');
}

let existing = null;
try { existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); } catch {}
if (existing?.target_sha === targetSha && existing?.run_id === record.run_id) {
  console.log('[benchmark-mirror] exact summary already present in repository file.');
  process.exit(0);
}

mkdirSync('benchmarks', { recursive: true });
writeFileSync(OUTPUT_PATH, `${serialized}\n`);
for (const [key, value] of [
  ['user.name', 'Cloudflare Benchmark Mirror'],
  ['user.email', 'benchmark-mirror@users.noreply.github.com'],
]) {
  if (run('git', ['config', key, value]).status !== 0) {
    console.log(`[benchmark-mirror] git config failed for ${key}.`);
    process.exit(0);
  }
}
if (run('git', ['add', OUTPUT_PATH]).status !== 0) process.exit(0);
const commit = run('git', ['commit', '-m', `benchmark: mirror summary ${targetSha.slice(0, 8)}`]);
if (commit.status !== 0) {
  console.log('[benchmark-mirror] no summary commit created.');
  process.exit(0);
}
const push = run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
if (push.status !== 0) {
  console.log('[benchmark-mirror] Git push unavailable from Workers Builds checkout.');
  if (push.stderr.trim()) console.log(push.stderr.trim().split('\n').slice(-3).join('\n'));
  process.exit(0);
}
console.log(`[benchmark-mirror] pushed exact summary ${record.run_id} to ${OUTPUT_PATH}.`);
