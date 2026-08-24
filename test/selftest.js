// Offline pipeline check: builds fake card fixtures, runs a full scan with
// the mock provider (no network/API cost), and sanity-checks the results.
// Run with: node test/selftest.js
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';

import { extractCardFromPng } from '../src/cardParser.js';
import { createProvider } from '../src/llmClient.js';

const run = promisify(execFile);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // dummy CRC, our reader ignores it
}

function buildFakePng(cardObject) {
  const base64 = Buffer.from(JSON.stringify(cardObject), 'utf8').toString('base64');
  const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(base64, 'latin1')]);
  return Buffer.concat([PNG_SIGNATURE, pngChunk('tEXt', textData), pngChunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-selftest-'));
  const charactersDir = path.join(dir, 'characters');
  const cacheFile = path.join(dir, 'data', 'cache.json');
  const trashDir = path.join(dir, 'data', 'trash');
  await mkdir(charactersDir, { recursive: true });

  const goodCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Test Good Card',
      description: 'A sharp, specific 700-token-style description with concrete traits and voice.',
      personality: 'Dry wit, guarded, fiercely loyal once trust is earned.',
      scenario: 'Meets the user during a blackout in a coastal research station.',
      first_mes: 'The lights flicker out. "...Stay where you are. I know this building better than you."',
      mes_example: '<START>\n{{user}}: Who are you?\n{{char}}: *doesn\'t turn around* Someone who knows where the exits are.',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['test'],
    },
  };

  const bloatedCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Test Bloated Card',
      description: 'Very very very long padded repeated description. '.repeat(200),
      personality: 'Generic nice kind friendly good person. '.repeat(50),
      scenario: '',
      first_mes: 'Hello! Nice to meet you!',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['test'],
    },
  };

  await writeFile(path.join(charactersDir, 'good-card.png'), buildFakePng(goodCard));
  await writeFile(path.join(charactersDir, 'bloated-card.png'), buildFakePng(bloatedCard));

  // sanity-check the parser directly before going through the CLI
  const parsed = extractCardFromPng(buildFakePng(goodCard));
  assert.equal(parsed.name, 'Test Good Card');
  assert.ok(parsed.fields.description.includes('sharp, specific'));
  console.log('✓ cardParser extracts embedded chara chunk correctly');

  const config = {
    charactersDir,
    cacheFile,
    trashDir,
    provider: 'mock',
    concurrency: 2,
    port: 4180,
  };
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const dryRun = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'scan', '--config', configPath, '--dry-run']);
  assert.match(dryRun.stdout, /2 card files found/);
  console.log('✓ scan --dry-run reports correct card count without scoring');

  const scan = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'scan', '--config', configPath]);
  assert.match(scan.stdout, /2 scored, 0 errors/);
  console.log('✓ scan (mock provider) scores both cards with 0 errors');

  // Resolve the score file the same way the app does, rather than assuming a
  // fixed name — the folder determines it (see cachePath.js).
  const { resolveCacheFile } = await import('../src/cachePath.js');
  const activeCacheFile = await resolveCacheFile(cacheFile, charactersDir);
  const cache = JSON.parse(await readFile(activeCacheFile, 'utf8'));
  assert.equal(Object.keys(cache.cards).length, 2);
  const goodResult = cache.cards['good-card.png'].result;
  assert.ok(goodResult.overall_score >= 1 && goodResult.overall_score <= 10);
  assert.ok(Object.keys(goodResult.fields).length > 0);
  console.log('✓ cache file has structured per-field results for both cards');

  const rescan = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'scan', '--config', configPath]);
  assert.match(rescan.stdout, /0 need scoring/);
  console.log('✓ second scan skips already-cached cards (no rescore without --rescore)');

  // Simulate a card that failed on a previous run (e.g. a network error, a bad
  // response) and confirm the next plain `scan` — no --rescore needed — picks
  // it back up automatically, exactly like a real failed card would.
  const cacheWithFailure = JSON.parse(await readFile(activeCacheFile, 'utf8'));
  cacheWithFailure.cards['bloated-card.png'].result = null;
  cacheWithFailure.cards['bloated-card.png'].error = 'simulated network failure';
  await writeFile(activeCacheFile, JSON.stringify(cacheWithFailure, null, 2));

  const scanAfterFailure = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'scan', '--config', configPath]);
  assert.match(scanAfterFailure.stdout, /1 need scoring/);
  assert.match(scanAfterFailure.stdout, /1 scored, 0 errors/);
  console.log('✓ a previously-failed card is automatically retried on the next scan (no --rescore needed)');

  const cacheAfterRetry = JSON.parse(await readFile(activeCacheFile, 'utf8'));
  assert.equal(cacheAfterRetry.cards['bloated-card.png'].error, null);
  assert.ok(cacheAfterRetry.cards['bloated-card.png'].result.overall_score >= 1);
  console.log('✓ the retried card now has a clean result and no error in the cache');

  const stats = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'stats', '--config', configPath]);
  assert.match(stats.stdout, /Total cached entries: 2/);
  console.log('✓ stats command summarizes the cache');

  // quick server smoke test: list + fetch one card detail + image bytes
  const { startServer } = await import('../src/server.js');
  const resolvedConfig = {
    ...config,
    charactersDir,
    cacheFile,
    trashDir,
    configPath,
    weights: (await import('../src/scorer.js')).DEFAULT_WEIGHTS,
  };
  const server = await startServer(resolvedConfig);
  try {
    const listRes = await fetch('http://localhost:4180/api/cards');
    const list = await listRes.json();
    assert.equal(list.cards.length, 2);
    console.log('✓ server /api/cards lists both cards');

    const detailRes = await fetch('http://localhost:4180/api/cards/good-card.png');
    const detail = await detailRes.json();
    assert.equal(detail.name, 'Test Good Card');
    console.log('✓ server /api/cards/:id returns full field/score detail');

    const imgRes = await fetch('http://localhost:4180/api/cards/good-card.png/image');
    assert.equal(imgRes.status, 200);
    console.log('✓ server serves the PNG thumbnail bytes');

    // settings panel: read current (mock) settings, list models, switch provider, persist
    const settingsRes = await fetch('http://localhost:4180/api/settings');
    const settings = await settingsRes.json();
    assert.equal(settings.provider, 'mock');
    assert.ok(settings.presets.nanogpt);
    assert.equal(settings.presets.nanogpt.baseURL, 'https://nano-gpt.com/api/v1');
    console.log('✓ server /api/settings reports current provider and includes the NanoGPT preset');

    const modelsRes = await fetch('http://localhost:4180/api/models');
    const modelsData = await modelsRes.json();
    assert.deepEqual(modelsData.models, ['mock-heuristic']);
    console.log('✓ server /api/models lists models for the current provider');

    const saveSettingsRes = await fetch('http://localhost:4180/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'nanogpt', apiKey: 'test-key-123', model: 'some-model', requestsPerMinute: 45 }),
    });
    const saveSettings = await saveSettingsRes.json();
    assert.equal(saveSettings.persisted, true);
    const onDiskAfterSettings = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(onDiskAfterSettings.provider, 'nanogpt');
    assert.equal(onDiskAfterSettings.apiKey, 'test-key-123');
    assert.equal(onDiskAfterSettings.requestsPerMinute, 45);
    console.log('✓ server /api/settings switches provider and persists provider/model/apiKey/rate to config.json');

    const settingsAfter = await (await fetch('http://localhost:4180/api/settings')).json();
    assert.equal(settingsAfter.requestsPerMinute, 45);
    assert.equal(settingsAfter.presets.nanogpt.requestsPerMinute, 60);
    assert.equal(settingsAfter.presets.nanogpt.maxConcurrency, 10);
    console.log('✓ settings reports the saved rate and NanoGPT\'s documented 60/min + 10-concurrent limits');

    // switch back to mock so nothing below tries to hit the real network
    await fetch('http://localhost:4180/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock' }),
    });

    // folder picker: browse to the parent dir and confirm it lists the characters folder
    const browseRes = await fetch(`http://localhost:4180/api/browse?path=${encodeURIComponent(dir)}`);
    const browse = await browseRes.json();
    assert.ok(browse.dirs.some((d) => d.name === 'characters'));
    console.log('✓ server /api/browse lists subdirectories for the folder picker');

    // switch to a second characters folder and confirm it's a clean, isolated cache
    const charactersDir2 = path.join(dir, 'characters2');
    await mkdir(charactersDir2, { recursive: true });
    await writeFile(path.join(charactersDir2, 'other-card.png'), buildFakePng({ ...goodCard, data: { ...goodCard.data, name: 'Other Folder Card' } }));

    const switchRes = await fetch('http://localhost:4180/api/settings/characters-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: charactersDir2 }),
    });
    const switchData = await switchRes.json();
    assert.equal(switchData.persisted, true);
    console.log('✓ server switches charactersDir and persists it to config.json');

    const onDiskConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(onDiskConfig.charactersDir, charactersDir2);
    console.log('✓ config.json on disk reflects the newly picked folder');

    const listAfterSwitchRes = await fetch('http://localhost:4180/api/cards');
    const listAfterSwitch = await listAfterSwitchRes.json();
    assert.equal(listAfterSwitch.cards.length, 1);
    assert.equal(listAfterSwitch.cards[0].overallScore, null);
    console.log('✓ switched folder shows its own (unscored) cards, not the previous folder\'s cache');

    // switch back so the delete test below still targets the original two-card folder
    await fetch('http://localhost:4180/api/settings/characters-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: charactersDir }),
    });

    const delRes = await fetch('http://localhost:4180/api/cards/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['bloated-card.png'] }),
    });
    const del = await delRes.json();
    assert.equal(del.moved.length, 1);
    console.log('✓ server moves a deleted card into the trash folder');

    const trashRes = await fetch('http://localhost:4180/api/trash');
    const trash = await trashRes.json();
    assert.equal(trash.items.length, 1);
    console.log('✓ server lists the trashed card for possible restore');
  } finally {
    server.close();
  }

  await rm(dir, { recursive: true, force: true });

  await testRetryAfterHonored();
  await testJsonRepairRetryGetsMoreTokens();
  await testTimeoutRetriesOnlyOnce();
  await testTimeoutRetryGetsLongerDeadline();
  await testCacheFollowsTheFolder();
  await testMergeCaches();

  console.log('\nAll self-tests passed.');
}

// Splitting scores across two cache files (the folder-switch bug) meant work
// already paid for looked unscored. Merging must recover it without re-scoring,
// must never let a stale error overwrite a real score, and must drop entries for
// cards that no longer exist.
async function testMergeCaches() {
  const { mergeCaches } = await import('../src/mergeCaches.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-merge-'));
  const charactersDir = path.join(dir, 'characters');
  const cacheFile = path.join(dir, 'data', 'cache.json');
  await mkdir(charactersDir, { recursive: true });
  await mkdir(path.dirname(cacheFile), { recursive: true });

  for (const n of ['a', 'b', 'c']) {
    await writeFile(path.join(charactersDir, `${n}.png`), buildFakePng({
      spec: 'chara_card_v2',
      data: { name: n, description: 'd', personality: '', scenario: '', first_mes: 'hi', mes_example: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [] },
    }));
  }

  const scored = (score, when) => ({ name: 'x', scoredAt: when, result: { overall_score: score }, error: null });
  const failed = (when) => ({ name: 'x', scoredAt: when, result: null, error: 'Request timed out after 120s' });

  // Legacy file: a scored, b FAILED, plus a ghost whose card was deleted.
  await writeFile(cacheFile, JSON.stringify({
    version: 1,
    cards: { 'a.png': scored(7, '2026-01-01T00:00:00Z'), 'b.png': failed('2026-01-01T00:00:00Z'), 'ghost.png': failed('2026-01-01T00:00:00Z') },
  }));

  // Hashed file (written after a folder switch): b later SUCCEEDED, c is new.
  const { hashedCacheFileFor } = await import('../src/cachePath.js');
  await writeFile(hashedCacheFileFor(cacheFile, charactersDir), JSON.stringify({
    version: 1,
    charactersDir,
    cards: { 'b.png': scored(9, '2026-02-01T00:00:00Z'), 'c.png': scored(4, '2026-02-01T00:00:00Z') },
  }));

  const r = await mergeCaches({ cacheFile, charactersDir });
  const merged = JSON.parse(await readFile(r.dest, 'utf8')).cards;

  assert.equal(Object.keys(merged).length, 3, 'expected exactly the three real cards');
  assert.equal(merged['a.png'].result.overall_score, 7, 'a card only in the legacy file must be carried over');
  assert.equal(merged['b.png'].result.overall_score, 9, 'a real score must win over a stale error for the same card');
  assert.equal(merged['b.png'].error, null);
  assert.equal(merged['c.png'].result.overall_score, 4);
  assert.equal(merged['ghost.png'], undefined, 'an entry for a deleted card must be pruned');
  assert.ok(r.backup, 'the previous file must be backed up before rewriting');
  console.log(`✓ merging split caches recovers every score (${r.added} added, ${r.pruned} phantom pruned) without re-scoring`);
  console.log('✓ a real score always wins over a stale error for the same card');

  await rm(dir, { recursive: true, force: true });
}

// Scores must always be found again for the folder they belong to. An earlier
// version keyed the "initial" folder to the configured cacheFile and any
// later-picked folder to a hashed file — so switching folders in the dashboard
// wrote scores to cache-<hash>.json while config.json was updated to that
// folder, and the next startup read the empty configured file. A full night of
// scoring looked like it had vanished.
async function testCacheFollowsTheFolder() {
  const { resolveCacheFile } = await import('../src/cachePath.js');
  const { Store } = await import('../src/store.js');

  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-cachepath-'));
  const cacheFile = path.join(dir, 'data', 'cache.json');
  const folderA = path.join(dir, 'A');
  const folderB = path.join(dir, 'B');
  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });

  // Score something against folder B, as a folder switch would.
  const fileB = await resolveCacheFile(cacheFile, folderB);
  const storeB = await new Store(fileB, folderB).load();
  await storeB.set('card.png', { name: 'B card', result: { overall_score: 7 }, error: null });

  // Resolving folder B again — a fresh process, as after a restart — must find
  // the same file, not a new empty one.
  const fileBAgain = await resolveCacheFile(cacheFile, folderB);
  assert.equal(fileBAgain, fileB, 'a folder must resolve to the same cache file every time');
  const reloaded = await new Store(fileBAgain, folderB).load();
  assert.equal(reloaded.get('card.png')?.result.overall_score, 7);
  console.log('✓ a folder resolves to the same score file across restarts (scores are not orphaned)');

  // Folder A must not see folder B's scores.
  const fileA = await resolveCacheFile(cacheFile, folderA);
  assert.notEqual(fileA, fileB);
  const storeA = await new Store(fileA, folderA).load();
  assert.equal(storeA.get('card.png'), undefined);
  console.log('✓ a different folder gets its own scores, not the previous folder\'s');

  // A legacy cache.json written before folders were recorded is still adopted.
  const legacyDir = await mkdtemp(path.join(tmpdir(), 'sillyscore-legacy-'));
  const legacyCache = path.join(legacyDir, 'data', 'cache.json');
  await mkdir(path.dirname(legacyCache), { recursive: true });
  await writeFile(legacyCache, JSON.stringify({ version: 1, cards: { 'old.png': { name: 'Old', result: { overall_score: 5 }, error: null } } }));
  const resolvedLegacy = await resolveCacheFile(legacyCache, path.join(legacyDir, 'chars'));
  assert.equal(resolvedLegacy, legacyCache, 'an existing cache.json from an older version must still be used');
  console.log('✓ a cache.json written by an older version is still picked up, not orphaned');

  await rm(dir, { recursive: true, force: true });
  await rm(legacyDir, { recursive: true, force: true });
}

// Retrying a timeout with the SAME deadline that just proved too short turns a
// merely-slow model into a failed card. Measured against a model whose latency
// straddles the timeout, same-deadline retries failed 8-17% of cards; escalating
// the deadline failed 0%. The retry must ask for more time, not the same time.
async function testTimeoutRetryGetsLongerDeadline() {
  const FIRST_TIMEOUT = 400;
  const RESPOND_AFTER = 600; // slower than attempt 1's deadline, inside attempt 2's
  let attempts = 0;

  const slowApi = createServer((req, res) => {
    attempts++;
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: { description: { score: 6, strengths: 'a', weaknesses: 'b', suggestions: 'c' } }, overall_score: 6, top_priority_improvements: [], summary: 'ok' }) }, finish_reason: 'stop' }],
      }));
    }, RESPOND_AFTER);
  });
  await new Promise((resolve) => slowApi.listen(0, resolve));

  const provider = createProvider({
    provider: 'openai',
    baseURL: `http://localhost:${slowApi.address().port}`,
    apiKey: 'test',
    model: 'test-model',
    timeoutMs: FIRST_TIMEOUT,
    requestsPerMinute: 0,
  });

  const { scoreCard } = await import('../src/scorer.js');
  const result = await scoreCard({ name: 'Slow Model Card', fields: { description: 'a description' } }, provider);

  slowApi.closeAllConnections?.();
  slowApi.close();

  assert.equal(result.fields.description.score, 6);
  assert.equal(attempts, 2, `expected the first attempt to time out and a second to succeed, saw ${attempts}`);
  console.log(`✓ a timed-out request is retried with a longer deadline (${FIRST_TIMEOUT}ms → ${FIRST_TIMEOUT * 2}ms) and succeeds instead of failing`);
}

// A request that times out is almost always going to time out again — retrying
// it on the full exponential ladder burned 5 x the timeout (10 minutes at the
// 120s default) per card and still failed. This was the dominant cost in a real
// 14-hour scan that processed only ~44 cards/hour. Cap timeout retries at one.
async function testTimeoutRetriesOnlyOnce() {
  let attempts = 0;
  const hangingApi = createServer(() => {
    attempts++;
    // never respond — force the client-side timeout path
  });
  await new Promise((resolve) => hangingApi.listen(0, resolve));
  const port = hangingApi.address().port;

  const provider = createProvider({
    provider: 'openai',
    baseURL: `http://localhost:${port}`,
    apiKey: 'test',
    model: 'test-model',
    timeoutMs: 400,
  });

  const start = Date.now();
  await assert.rejects(() => provider.chat({ system: 'sys', user: 'hello' }), /timed out/i);
  const elapsedMs = Date.now() - start;

  hangingApi.closeAllConnections?.();
  hangingApi.close();

  assert.equal(attempts, 2, `expected 1 initial attempt + 1 retry, got ${attempts} attempts`);
  // 2 attempts x 400ms + ~1.5s backoff. The old 5-attempt ladder would be >3.5s.
  assert.ok(elapsedMs < 3500, `expected a capped timeout ladder, took ${elapsedMs}ms`);
  console.log(`✓ a timing-out request retries only once (${attempts} attempts, ${elapsedMs}ms) instead of burning the full ladder`);
}

// A NanoGPT-style 429 with a Retry-After header must be honored as the actual
// wait time, not papered over with generic exponential backoff — that's the
// difference between behaving within a provider's stated limits and not.
async function testRetryAfterHonored() {
  let requestCount = 0;
  const fakeApi = createServer((req, res) => {
    requestCount++;
    if (requestCount === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok after retry' } }] }));
  });
  await new Promise((resolve) => fakeApi.listen(0, resolve));
  const port = fakeApi.address().port;

  const provider = createProvider({ provider: 'openai', baseURL: `http://localhost:${port}`, apiKey: 'test', model: 'test-model' });
  const start = Date.now();
  const reply = await provider.chat({ system: 'sys', user: 'hello' });
  const elapsedMs = Date.now() - start;

  fakeApi.close();

  assert.equal(reply, 'ok after retry');
  assert.equal(requestCount, 2);
  // The header says wait 1s. If this instead used the generic exponential
  // backoff (>=1500ms for the first retry), elapsed would exceed 1500ms.
  assert.ok(elapsedMs < 1500, `expected the 1s Retry-After to be honored (elapsed ${elapsedMs}ms should be <1500ms)`);
  assert.ok(elapsedMs >= 900, `expected roughly a 1s wait, got ${elapsedMs}ms (too fast — header may have been ignored)`);
  console.log(`✓ a 429 with Retry-After: 1 is honored as a ~1s wait (actual: ${elapsedMs}ms), then succeeds`);
}

// If a card's JSON response gets cut off (hitting max_tokens) rather than being
// genuinely malformed, the repair retry must ask for MORE room, not resend the
// same budget and get cut off identically. This was a real bug found by driving
// the CLI against a fake provider that truncates: every affected card cost 2x
// the latency and still failed. Guards against that regressing silently.
async function testJsonRepairRetryGetsMoreTokens() {
  const requestedMaxTokens = [];
  const fakeApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requestedMaxTokens.push(parsed.max_tokens);
      const content =
        requestedMaxTokens.length === 1
          ? '{"fields": {"description": {"score": 7, "strengths": "cut off mid-strin' // truncated, invalid JSON
          : JSON.stringify({ fields: { description: { score: 7, strengths: 'ok', weaknesses: 'ok', suggestions: 'ok' } }, overall_score: 7, top_priority_improvements: [], summary: 'ok' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => fakeApi.listen(0, resolve));
  const port = fakeApi.address().port;

  const { scoreCard } = await import('../src/scorer.js');
  const provider = createProvider({ provider: 'openai', baseURL: `http://localhost:${port}`, apiKey: 'test', model: 'test-model' });
  const card = { name: 'Truncation Test Card', fields: { description: 'A test description.' } };
  const result = await scoreCard(card, provider);

  fakeApi.close();

  assert.equal(requestedMaxTokens.length, 2, 'expected exactly one repair retry');
  assert.ok(
    requestedMaxTokens[1] > requestedMaxTokens[0],
    `expected the retry's max_tokens (${requestedMaxTokens[1]}) to exceed the first attempt's (${requestedMaxTokens[0]})`,
  );
  assert.equal(result.fields.description.score, 7);
  console.log(`✓ JSON-repair retry raises max_tokens (${requestedMaxTokens[0]} → ${requestedMaxTokens[1]}) instead of resending the same budget`);
}

main().catch((err) => {
  console.error('SELF-TEST FAILED:', err);
  process.exitCode = 1;
});
