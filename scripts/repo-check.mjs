import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url);
const expected = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgres-snapshot-evaluations-and-fenced-notification-outbox.md',
  'docs/closed-book-contract.md',
  'docs/research-log.md',
  'package-lock.json',
  'package.json',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/crypto.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/notifier.js',
  'src/provider.js',
  'src/repository.js',
  'src/service.js',
  'test/integration/postgresql.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
];

async function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await walk(new URL(`${entry.name}/`, directory), relative));
    else paths.push(relative);
  }
  return paths;
}

for (const path of expected) {
  assert.equal((await stat(new URL(path, root))).isFile(), true, `missing required file: ${path}`);
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(packageJson.private, true);
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(
  packageJson.repository.url,
  'git+https://github.com/estelledc/system-design-20-metrics-monitoring-alerting.git',
);
for (const script of ['lint', 'test', 'test:infra', 'smoke:infra', 'benchmark:infra', 'audit', 'check', 'check:ci']) {
  assert.equal(typeof packageJson.scripts[script], 'string', `missing package script: ${script}`);
}
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);

const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /permissions:\n  contents: read/);
const actionUses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
assert.ok(actionUses.length >= 2);
assert.ok(actionUses.every((reference) => /^[0-9a-f]{40}$/.test(reference)), 'actions must use full commit pins');

const compose = await readFile(new URL('compose.yaml', root), 'utf8');
assert.match(compose, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(compose, /pg_isready -U postgres -d metrics_alerting/);

const schema = await readFile(new URL('sql/schema.sql', root), 'utf8');
for (const contract of [
  'PRIMARY KEY (source_id, source_epoch, batch_sequence)',
  'UNIQUE (rule_id, generation, slot)',
  "status IN ('inactive', 'pending', 'firing')",
  "outcome IN ('true', 'false', 'unknown')",
  "status IN ('routable', 'suppressed')",
  "status IN ('pending', 'leased', 'provider_accepted')",
  'UNIQUE (notification_id, attempt)',
  "missing_policy = 'reset_pending_keep_firing'",
]) assert.ok(schema.includes(contract), `missing schema contract: ${contract}`);

const repository = await readFile(new URL('src/repository.js', root), 'utf8');
for (const contract of [
  'pg_advisory_xact_lock',
  'ingest_revision <= $4',
  "throw fenced('evaluator authority epoch'",
  'transitionRuleState(before, outcome',
  'INSERT INTO mm_notification_outbox',
  "status = 'leased'",
  "status = 'provider_accepted'",
  'FOR UPDATE SKIP LOCKED',
]) assert.ok(repository.includes(contract), `missing repository contract: ${contract}`);

const service = await readFile(new URL('src/service.js', root), 'utf8');
for (const contract of ['MON_CRASH_AFTER_INGEST_COMMIT', 'MON_CRASH_AFTER_EVALUATION_COMMIT']) {
  assert.ok(service.includes(contract), `missing service crash boundary: ${contract}`);
}
const notifier = await readFile(new URL('src/notifier.js', root), 'utf8');
assert.ok(notifier.includes('MON_CRASH_AFTER_PROVIDER_ACCEPTED'));
assert.ok(notifier.includes("phase !== 'provider_accepted'"));

const logSources = [service, notifier, await readFile(new URL('src/provider.js', root), 'utf8')];
const logBodies = logSources.flatMap((source) => (
  [...source.matchAll(/(?:this\.)?logger\(\{([\s\S]*?)\}\)/g)].map((match) => match[1])
));
assert.ok(logBodies.length >= 12, 'expected explicit low-cardinality log sites');
for (const body of logBodies) {
  for (const forbiddenField of [
    'sourceId', 'seriesDigest', 'metric', 'labels', 'value', 'ruleId', 'incidentId',
    'notificationId', 'silenceId', 'requestKey', 'providerToken', 'body', 'authorization',
  ]) {
    assert.equal(new RegExp(`\\b${forbiddenField}\\s*:`).test(body), false, `ordinary log includes ${forbiddenField}`);
  }
}

const research = await readFile(new URL('docs/research-log.md', root), 'utf8');
for (const pinned of [
  '9d8388721e7231442763ad37398b8d82224aa68f',
  '8a411d9d4870e6b703a51773b0441445bf38f632',
  'ca659470078b3e84a8e81f17350f61f187b39780',
  '1ccf8a3658fb1bd34c1a5e126aceec02598e5b8bf80ff4ff02245958026e0c54',
]) assert.ok(research.includes(pinned), `research log is missing fixed evidence identity: ${pinned}`);

const integration = await readFile(new URL('test/integration/postgresql.test.js', root), 'utf8');
assert.match(integration, /infrastructure tests never skip/);
assert.doesNotMatch(integration, /\.skip\s*\(/);
const smoke = await readFile(new URL('scripts/infra-smoke.mjs', root), 'utf8');
assert.match(smoke, /killedProcesses/);
assert.match(smoke, /humanDeliveryProved: false/);
const benchmark = await readFile(new URL('scripts/infra-benchmark.mjs', root), 'utf8');
for (const fixture of ['seriesCount = 64', 'pointsPerSeries = 32', 'ruleCount = 32']) {
  assert.ok(benchmark.includes(fixture), `benchmark fixture is not fixed: ${fixture}`);
}

const files = await walk(root);
const portable = files.filter((path) => /\.(?:md|js|mjs|json|sql|ya?ml)$/.test(path));
const forbidden = [
  /\/Users\//,
  /\/private\/tmp\//,
  /file:\/\//,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  new RegExp(['Co', 'Authored-By:'].join('-')),
];
for (const path of portable) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const pattern of forbidden) assert.equal(pattern.test(contents), false, `${path} contains forbidden portable data`);
}

for (const path of files.filter((value) => value.endsWith('.md'))) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    assert.equal((await stat(new URL(resolved, root))).isFile(), true, `${path} has broken link: ${target}`);
  }
}

for (const path of files.filter((value) => /\.(?:js|mjs)$/.test(value))) {
  execFileSync(process.execPath, ['--check', path], { cwd: root, stdio: 'inherit' });
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`${JSON.stringify({
  evidence: 'repository_policy_check',
  files: files.length,
  serviceLogSitesChecked: logBodies.length,
  markdownLinksChecked: true,
  syntaxChecked: true,
})}\n`);
