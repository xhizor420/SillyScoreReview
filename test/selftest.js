// Offline pipeline check: builds fake card fixtures, runs a full scan with
// the mock provider (no network/API cost), and sanity-checks the results.
// Run with: node test/selftest.js
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

import { extractCardFromPng } from '../src/cardParser.js';

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

  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(Object.keys(cache.cards).length, 2);
  const goodResult = cache.cards['good-card.png'].result;
  assert.ok(goodResult.overall_score >= 1 && goodResult.overall_score <= 10);
  assert.ok(Object.keys(goodResult.fields).length > 0);
  console.log('✓ cache file has structured per-field results for both cards');

  const rescan = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'scan', '--config', configPath]);
  assert.match(rescan.stdout, /0 need scoring/);
  console.log('✓ second scan skips already-cached cards (no rescore without --rescore)');

  const stats = await run('node', [path.join(PROJECT_ROOT, 'src/cli.js'), 'stats', '--config', configPath]);
  assert.match(stats.stdout, /Total cached entries: 2/);
  console.log('✓ stats command summarizes the cache');

  // quick server smoke test: list + fetch one card detail + image bytes
  const { startServer } = await import('../src/server.js');
  const resolvedConfig = { ...config, charactersDir, cacheFile, trashDir, weights: (await import('../src/scorer.js')).DEFAULT_WEIGHTS };
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
  console.log('\nAll self-tests passed.');
}

main().catch((err) => {
  console.error('SELF-TEST FAILED:', err);
  process.exitCode = 1;
});
