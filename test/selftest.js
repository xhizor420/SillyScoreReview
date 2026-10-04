// Offline pipeline check: builds fake card fixtures, runs a full scan with
// the mock provider (no network/API cost), and sanity-checks the results.
// Run with: node test/selftest.js
import { mkdtemp, writeFile, rm, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import { crc32 as zlibCrc32 } from 'node:zlib';

import { extractCardFromPng } from '../src/cardParser.js';
import { createProvider } from '../src/llmClient.js';

const run = promisify(execFile);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlibCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * A minimal but structurally real PNG: signature, IHDR, the card's chara chunk,
 * one IDAT and IEND, with valid CRCs throughout. Fixtures have to be real PNGs
 * now that the tool writes cards back out as well as reading them.
 */
function buildFakePng(cardObject) {
  const base64 = Buffer.from(JSON.stringify(cardObject), 'utf8').toString('base64');
  const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(base64, 'latin1')]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);   // width
  ihdr.writeUInt32BE(1, 4);   // height
  ihdr[8] = 8;                // bit depth
  ihdr[9] = 6;                // colour type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', textData),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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

    // copy selected cards into another folder: originals untouched, scores carried
    const keepersDir = path.join(dir, 'keepers');
    const copyRes = await fetch('http://localhost:4180/api/cards/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['good-card.png', 'bloated-card.png'], destination: keepersDir }),
    });
    const copy = await copyRes.json();
    assert.equal(copy.errors.length, 0, `copy reported errors: ${JSON.stringify(copy.errors)}`);
    assert.equal(copy.copied.length, 2);
    assert.deepEqual((await readdir(keepersDir)).sort(), ['bloated-card.png', 'good-card.png']);
    console.log('✓ server copies selected cards into a destination folder it creates on demand');

    const listAfterCopy = await (await fetch('http://localhost:4180/api/cards')).json();
    assert.equal(listAfterCopy.cards.length, 2, 'copying must not remove the originals');
    assert.ok(listAfterCopy.cards.every((c) => c.overallScore != null), 'originals keep their scores');
    console.log('✓ the originals and their scores are left exactly as they were');

    // the copies arrive already scored — pointing the tool at the new folder
    // must not demand a rescan of cards that were just scored
    await fetch('http://localhost:4180/api/settings/characters-dir', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: keepersDir }),
    });
    const listInKeepers = await (await fetch('http://localhost:4180/api/cards')).json();
    assert.equal(listInKeepers.cards.length, 2);
    assert.ok(listInKeepers.cards.every((c) => c.overallScore != null), 'copied cards should arrive with their scores');
    console.log('✓ scores travel with the copies, so the destination folder needs no rescan');

    await fetch('http://localhost:4180/api/settings/characters-dir', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: charactersDir }),
    });

    // copying the same cards again is a no-op, not a pile of duplicates
    const copyAgain = await (await fetch('http://localhost:4180/api/cards/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['good-card.png', 'bloated-card.png'], destination: keepersDir }),
    })).json();
    assert.equal(copyAgain.copied.length, 0);
    assert.equal(copyAgain.skipped.length, 2);
    assert.deepEqual((await readdir(keepersDir)).sort(), ['bloated-card.png', 'good-card.png']);
    console.log('✓ re-copying the same cards skips them instead of duplicating them');

    // a *different* card that happens to share a filename must not be overwritten
    const clashDir = path.join(dir, 'clash');
    await mkdir(clashDir, { recursive: true });
    await writeFile(path.join(clashDir, 'good-card.png'), buildFakePng({ ...goodCard, data: { ...goodCard.data, name: 'A Totally Different Card' } }));
    const copyClash = await (await fetch('http://localhost:4180/api/cards/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['good-card.png'], destination: clashDir }),
    })).json();
    assert.equal(copyClash.copied.length, 1);
    assert.equal(copyClash.copied[0].copiedAs, 'good-card (2).png');
    const clashOriginal = await extractCardFromPng(await readFile(path.join(clashDir, 'good-card.png')));
    assert.equal(clashOriginal.name, 'A Totally Different Card', 'an unrelated card with the same filename must survive');
    console.log('✓ a filename clash gets a suffix instead of overwriting the card already there');

    const copySelf = await fetch('http://localhost:4180/api/cards/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['good-card.png'], destination: charactersDir }),
    });
    assert.equal(copySelf.status, 400);
    console.log('✓ copying a folder onto itself is refused');

    // improve + save: the model proposes edits, nothing is written until asked,
    // and saving as a new card leaves the original (and its score) alone
    const { applyEdits } = await import('../src/improver.js');
    const improveRes = await fetch('http://localhost:4180/api/cards/good-card.png/improve', { method: 'POST' });
    const improve = await improveRes.json();
    assert.equal(improveRes.status, 200, `improve failed: ${JSON.stringify(improve)}`);
    assert.ok(improve.edits.length > 0, 'expected at least one placed edit');
    const firstField = improve.edits[0].target;
    assert.ok(improve.before[firstField], 'the original text must come back for side-by-side review');
    const e0 = improve.edits[0];
    assert.equal(improve.before[firstField].slice(e0.start, e0.end), e0.old, 'each edit says exactly which text it replaces');
    const proposedText = applyEdits(improve.before[firstField], improve.edits.filter((e) => e.target === firstField).map((e, order) => ({ ...e, order })));
    assert.ok(proposedText.startsWith(improve.before[firstField].slice(0, e0.start)), 'text before an edit is untouched');
    assert.deepEqual((await readdir(charactersDir)).sort(), ['bloated-card.png', 'good-card.png'],
      'asking for an improvement must not write any file');
    console.log(`✓ improve returns ${improve.edits.length} placed edit(s) against the exact original text, and writes nothing`);

    const saveRes = await fetch('http://localhost:4180/api/cards/good-card.png/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: { [firstField]: proposedText },
        mode: 'new',
        rescore: true,
      }),
    });
    const saved = await saveRes.json();
    assert.equal(saveRes.status, 200, `save failed: ${JSON.stringify(saved)}`);
    assert.equal(saved.file, 'good-card (improved).png');
    assert.ok(saved.previousScore != null, 'the original score should be carried over for a before/after');
    assert.ok(saved.entry.result, 'rescore:true should leave the new card scored');
    assert.equal(saved.entry.improvedFrom, 'good-card.png');
    console.log(`✓ saving as a new card writes "${saved.file}", scores it, and records the ${saved.previousScore}/10 it came from`);

    const improvedCard = await extractCardFromPng(await readFile(path.join(charactersDir, saved.file)));
    assert.equal(improvedCard.fields[firstField], proposedText);
    const untouched = await extractCardFromPng(await readFile(path.join(charactersDir, 'good-card.png')));
    assert.equal(untouched.fields[firstField], improve.before[firstField], 'the original card must be byte-identical in content');
    const listWithImproved = await (await fetch('http://localhost:4180/api/cards')).json();
    const originalRow = listWithImproved.cards.find((c) => c.id === 'good-card.png');
    assert.ok(originalRow.overallScore != null, 'the original keeps its own score');
    console.log('✓ the original card and its score are untouched by the improvement');

    // replace mode: in place, but with a restorable copy of the old version
    const replaceRes = await fetch('http://localhost:4180/api/cards/good-card.png/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { description: 'A hand-edited description.' }, mode: 'replace' }),
    });
    const replaced = await replaceRes.json();
    assert.equal(replaceRes.status, 200, `replace failed: ${JSON.stringify(replaced)}`);
    assert.equal(replaced.file, 'good-card.png');
    assert.ok(replaced.backedUpAs, 'replacing in place must keep a restorable copy');
    const edited = await extractCardFromPng(await readFile(path.join(charactersDir, 'good-card.png')));
    assert.equal(edited.fields.description, 'A hand-edited description.');
    assert.equal(edited.name, 'Test Good Card', 'editing one field must not touch the name');
    const backupCopy = await extractCardFromPng(await readFile(path.join(trashDir, replaced.backedUpAs)));
    assert.equal(backupCopy.fields.description, goodCard.data.description, 'the pre-edit version must be recoverable');
    const afterEdit = await (await fetch('http://localhost:4180/api/cards')).json();
    const editedRow = afterEdit.cards.find((c) => c.id === 'good-card.png');
    assert.equal(editedRow.overallScore, null, 'an edited card should not keep a score that describes the old text');
    assert.ok(editedRow.previousScore != null, 'but it should remember what it used to score');
    console.log(`✓ replacing in place edits the file, backs the old one up as "${replaced.backedUpAs}", and retires the stale score`);

    const saveNothing = await fetch('http://localhost:4180/api/cards/good-card.png/save', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: {} }),
    });
    assert.equal(saveNothing.status, 400);
    console.log('✓ a save with no edited fields is refused instead of rewriting the card for nothing');

    const backupsRes = await (await fetch('http://localhost:4180/api/backups')).json();
    assert.ok(backupsRes.backups.length >= 1, 'the dashboard should have snapshotted the cache on startup');
    console.log(`✓ the dashboard snapshotted the score file on startup (${backupsRes.backups.length} backup(s) listed)`);

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
    // The deleted card, plus the pre-edit copy kept by the replace above.
    assert.equal(trash.items.length, 2);
    assert.ok(trash.items.some((i) => i.file === 'bloated-card.png'));
    assert.ok(trash.items.some((i) => i.file.includes('before-edit')));
    console.log('✓ server lists the trashed card (and the pre-edit backup) for possible restore');
  } finally {
    server.close();
  }

  await rm(dir, { recursive: true, force: true });

  await testRetryAfterHonored();
  await testResponseLimitAndThinking();
  await testTimeoutRetriesOnlyOnce();
  await testTimeoutRetryGetsLongerDeadline();
  await testCacheFollowsTheFolder();
  await testMergeCaches();
  await testCardRoundTrip();
  await testImproverGuards();
  await testBackups();
  await testStopScan();
  await testFastScoring();
  await testCoalescedWrites();
  await testRunSupervision();
  await testEditablePrompts();
  await testIdeasThenRewrite();
  await testChangePicker();
  await testWriterNoteAndFlatCopy();
  await testCardEditsReview();
  await testTwoPassAndRawReplies();

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
/**
 * Response length and thinking models. No limit is sent unless you set one
 * (their reasoning counts against any limit); a limit you do set is sent as
 * is; reasoning that arrives inline never gets mistaken for the answer; and an
 * answer cut off by a limit is reported as exactly that.
 */
async function testResponseLimitAndThinking() {
  const sentMaxTokens = [];
  let mode = 'truncate-then-ok';
  const answer = JSON.stringify({ fields: { description: { score: 7, strengths: 'ok', weaknesses: 'ok', suggestions: 'ok' } }, overall_score: 7, top_priority_improvements: [], summary: 'ok' });
  const fakeApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      sentMaxTokens.push('max_tokens' in parsed ? parsed.max_tokens : 'not sent');
      let content = answer;
      let finish = 'stop';
      if (mode === 'truncate-then-ok' && sentMaxTokens.length === 1) content = '{"fields": {"description": {"score": 7, "strengths": "cut off mid-strin';
      if (mode === 'think') content = '<think>The first_mes has "{{user}} smiles" and {{char}} acts for {{user}} — {draft}.</think>\n' + answer;
      if (mode === 'think-no-open-tag') content = 'Weighing {{user}} and {{char}} macros {here}.</think>' + answer;
      if (mode === 'always-cut') { content = '{"fields": {"description": {"score": 7, "stren'; finish = 'length'; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }));
    });
  });
  await new Promise((resolve) => fakeApi.listen(0, resolve));
  const port = fakeApi.address().port;
  const { scoreCard } = await import('../src/scorer.js');
  const card = { name: 'Limit Test Card', fields: { description: 'A test description.' } };
  const make = (extra = {}) => createProvider({ provider: 'openai', baseURL: `http://localhost:${port}`, apiKey: 'test', model: 'test-model', ...extra });

  // default: no limit sent, on the first attempt or the repair retry
  const r1 = await scoreCard(card, make());
  assert.equal(r1.fields.description.score, 7);
  assert.deepEqual(sentMaxTokens, ['not sent', 'not sent'], 'with no limit set, max_tokens must not be sent at all');
  console.log('✓ by default no response limit is sent — not on the first try, not on the retry');

  // fast mode used to send its own 400-token cap; it must not any more
  sentMaxTokens.length = 0; mode = 'ok';
  await scoreCard(card, make(), { detail: 'fast' }).catch(() => {});
  assert.equal(sentMaxTokens[0], 'not sent', 'fast mode must not impose its own cap');

  // a limit you set is sent as-is
  sentMaxTokens.length = 0;
  await scoreCard(card, make({ maxTokens: 12000 }));
  assert.equal(sentMaxTokens[0], 12000);
  console.log('✓ fast mode no longer sends its own cap; a limit you set is sent exactly as set');

  // thinking models: inline reasoning full of {{user}} braces is not the answer
  for (const m of ['think', 'think-no-open-tag']) {
    mode = m;
    const r = await scoreCard(card, make());
    assert.equal(r.overall_score, 7, `${m}: the answer after the reasoning must be read`);
  }
  console.log('✓ an answer that follows inline <think> reasoning (braces and all) is read correctly');

  // a cut-off answer says so, rather than "unusable JSON"
  mode = 'always-cut';
  await assert.rejects(scoreCard(card, make({ maxTokens: 500 })), /cut off.*finish_reason: length/s);
  console.log('✓ an answer cut off by a response limit is reported as cut off, with the fix');

  fakeApi.close();
}

/**
 * Writing a card back out is the one operation in this tool that can destroy
 * data, so the round-trip is checked hard: pixels byte-identical, every CRC
 * valid, and everything the tool doesn't model (lorebook, creator_notes,
 * extensions) still present afterwards.
 */
async function testCardRoundTrip() {
  const { extractCardFromPng } = await import('../src/cardParser.js');
  const { serializeCard, applyFieldsToRaw } = await import('../src/cardWriter.js');
  const { crc32 } = await import('node:zlib');

  const original = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Round Trip',
      description: 'original description',
      personality: 'unchanged personality',
      scenario: '',
      first_mes: 'Hello {{user}}, I am {{char}}.',
      mes_example: '<START>\n{{user}}: hi\n{{char}}: hey',
      alternate_greetings: ['one', 'two'],
      character_book: { name: 'lore', entries: [{ keys: ['x'], content: 'secret lore' }] },
      creator_notes: 'please keep me',
      tags: ['test'],
      extensions: { depth_prompt: { depth: 4, prompt: 'stay in character' } },
    },
  };

  const idhr = Buffer.alloc(13);
  idhr.writeUInt32BE(2, 0); idhr.writeUInt32BE(2, 4); idhr[8] = 8; idhr[9] = 6;
  const realChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, c]);
  };
  const pixels = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const png = Buffer.concat([
    PNG_SIGNATURE,
    realChunk('IHDR', idhr),
    realChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(original)).toString('base64'), 'latin1')])),
    realChunk('IDAT', pixels),
    realChunk('IEND', Buffer.alloc(0)),
  ]);

  const parsed = extractCardFromPng(png);
  const { bytes } = serializeCard({
    filename: 'round-trip.png',
    originalBuffer: png,
    raw: parsed.raw,
    fields: { description: 'edited description', alternate_greetings: 'one\n\n---\n\ntwo\n\n---\n\nthree' },
  });

  // every chunk CRC must be valid, or SillyTavern (and every viewer) rejects it
  let offset = 8;
  const seen = [];
  let idat = null;
  while (offset + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    const stored = bytes.readUInt32BE(offset + 8 + len);
    assert.equal(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), stored, `${type} chunk has a bad CRC`);
    if (type === 'IDAT') idat = data;
    seen.push(type);
    offset += len + 12;
    if (type === 'IEND') break;
  }
  assert.deepEqual(seen, ['IHDR', 'tEXt', 'IDAT', 'IEND']);
  assert.ok(idat.equals(pixels), 'the artwork must be copied through byte-for-byte');
  console.log('✓ a rewritten card is a valid PNG (all CRCs check out) with the artwork untouched');

  const after = extractCardFromPng(bytes);
  assert.equal(after.fields.description, 'edited description');
  assert.equal(after.fields.personality, 'unchanged personality', 'untouched fields must not change');
  assert.deepEqual(after.raw.data.alternate_greetings, ['one', 'two', 'three']);
  assert.equal(after.raw.data.creator_notes, 'please keep me');
  assert.equal(after.raw.data.character_book.entries[0].content, 'secret lore');
  assert.deepEqual(after.raw.data.extensions, { depth_prompt: { depth: 4, prompt: 'stay in character' } });
  assert.deepEqual(after.tags, ['test']);
  console.log('✓ editing a field keeps the lorebook, creator notes, tags and extensions intact');

  // A file with no IHDR is already not a viewable image; editing it must still
  // preserve the card data rather than refusing and stranding it.
  const headerless = Buffer.concat([
    PNG_SIGNATURE,
    realChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(original)).toString('base64'), 'latin1')])),
    realChunk('IEND', Buffer.alloc(0)),
  ]);
  const headerlessOut = serializeCard({
    filename: 'headerless.png',
    originalBuffer: headerless,
    raw: extractCardFromPng(headerless).raw,
    fields: { description: 'still editable' },
  });
  assert.equal(extractCardFromPng(headerlessOut.bytes).fields.description, 'still editable');
  console.log('✓ a malformed PNG with no IHDR can still be edited instead of being rejected');

  // a V1 (flat) card must stay flat
  const v1 = applyFieldsToRaw({ name: 'Flat', description: 'old' }, { fields: { description: 'new' } });
  assert.equal(v1.description, 'new');
  assert.equal(v1.data, undefined, 'a V1 card must not grow a data wrapper');
  console.log('✓ a V1 flat card is edited in place without being converted to V2');
}

/** The rewrite path must refuse to silently pad a card — that was the whole complaint. */
async function testImproverGuards() {
  const { buildImprovePrompts, improveCard, placeEdits, applyEdits, editTargets, locate } = await import('../src/improver.js');

  const card = {
    name: 'Guard Test',
    fields: {
      description: 'Wren keeps the lighthouse. She is 180 cm tall. She is quiet. She wears a grey oilskin coat.',
      personality: 'terse',
      scenario: '',
      first_mes: 'Hi {{user}}, {{char}} here, {{user}}. She is quiet.',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: '',
    },
  };
  const critique = {
    fields: { description: { score: 3, weaknesses: 'vague', suggestions: 'be specific' } },
    summary: 'needs work',
    top_priority_improvements: ['sharpen the description'],
  };

  const prompts = buildImprovePrompts(card, critique);
  assert.match(prompts.user, /Critique of this field: scored 3\/10; weaknesses: vague/);
  assert.doesNotMatch(prompts.user, /must not exceed|token budget/, 'no length cap: a cap is what made rewrites cut details');
  assert.match(prompts.system, /KEEP EVERY DETAIL/);
  assert.match(prompts.system, /There is no length limit/);
  assert.match(prompts.system, /"find"/);
  assert.ok(!prompts.user.includes('### scenario'), 'empty fields are not offered for editing');
  console.log('✓ the improve prompt asks for anchored edits, carries the critique, and sets no length cap');

  // --- placing edits against the real text
  const targets = editTargets(card);
  const d = card.fields.description;
  assert.deepEqual(locate(d, 'She is 180 cm tall.'), { start: d.indexOf('She is 180'), end: d.indexOf('She is 180') + 19 });
  assert.equal(locate(card.fields.first_mes, 'She is quiet.').start, card.fields.first_mes.indexOf('She is quiet.'));
  assert.match(locate(d, 'She is tall.').error, /not in the card/);
  assert.match(locate('a. b. a.', 'a.').error, /more than once/, 'an ambiguous quote is refused, not guessed');
  // Curly quotes and collapsed spaces still find the real text.
  assert.ok(locate('She said “hi”  there.', 'She said "hi" there.').start === 0);
  console.log('✓ quotes are found exactly (or through curly quotes and spacing) — missing or ambiguous ones are refused');

  const { placed, unplaced } = placeEdits(targets, [
    { idea: 1, field: 'description', action: 'replace', find: 'She is quiet.', text: 'She is quiet, and listens more than she speaks.' },
    { idea: 1, field: 'description', action: 'insert_after', find: 'She wears a grey oilskin coat.', text: 'It smells of salt and lamp oil.' },
    { idea: 1, field: 'description', action: 'replace', find: 'She is quiet. She wears', text: 'x' },          // overlaps the first
    { idea: 1, field: 'description', action: 'replace', find: 'Nowhere in the card.', text: 'x' },             // missing
    { idea: 1, field: 'first_mes', action: 'replace', find: 'She is quiet.', text: 'She is quiet.' },           // no-op
    { idea: 1, field: 'personality', action: 'disable' },                                                       // card text only
    { idea: 1, field: 'lorebook:0', action: 'replace', find: 'x', text: 'y' },                                  // the lorebook isn't edited here
  ]);
  assert.equal(placed.length, 2);
  assert.deepEqual(unplaced.map((u) => u.reason), [
    'it overlaps another change to the same passage',
    'the quoted passage is not in the card',
    'it would change nothing',
    'it tries to switch something off — only card text is edited here',
    'it points at a part of the card that does not exist',
  ]);
  const after = applyEdits(d, placed);
  assert.equal(after, 'Wren keeps the lighthouse. She is 180 cm tall. She is quiet, and listens more than she speaks. She wears a grey oilskin coat. It smells of salt and lamp oil.');
  console.log('✓ edits change only their quoted passage; overlaps, misquotes, no-ops and impossible edits are set aside with the reason');

  // With a plan, an edit to a part no chosen idea is about is refused.
  const plan = { ideas: [{ id: 'idea-1', kind: 'extend', field: 'first_mes', title: 'Hook', change: 'End on a question.', quotes: [] }], canon: [], keepQuotes: [] };
  const planned = buildImprovePrompts(card, critique, { plan });
  assert.deepEqual([...planned.allowed], ['first_mes']);
  assert.match(planned.user, /### description \(REFERENCE ONLY/, 'the description goes along as the reference, not as something to edit');
  const strayProvider = {
    name: 's', model: 's',
    async chat() {
      return JSON.stringify({ edits: [
        { idea: 1, field: 'description', action: 'replace', find: 'She is quiet.', text: 'She is LOUD.' },
        { idea: 1, field: 'first_mes', action: 'insert_after', find: 'She is quiet.', text: 'Well? Are you coming in?' },
      ], headline: 'h' });
    },
  };
  const out = await improveCard(card, critique, strayProvider, { plan });
  assert.deepEqual(out.edits.map((e) => e.target), ['first_mes']);
  assert.equal(out.unplaced[0].reason, 'it changes a part of the card no chosen idea was about');
  assert.equal(out.edits[0].new, ' Well? Are you coming in?', 'an insert gets the space it needs');
  assert.equal(out.edits[0].kind, 'extend');
  console.log('✓ an edit outside the chosen ideas is refused; inserts get their spacing; each edit names its idea');

  // Filling an empty field: the one edit with nothing to quote.
  const fillTargets = editTargets(card);
  assert.equal(fillTargets.get('mes_example').empty, true, 'empty fields worth filling are offered');
  assert.ok(!fillTargets.has('system_prompt'), 'but not the system prompts (they replace the user\'s own)');
  const fill = placeEdits(fillTargets, [
    { idea: 1, field: 'mes_example', action: 'write', find: '', text: '<START>\n{{char}}: "Storm\'s coming."' },
    { idea: 1, field: 'mes_example', action: 'write', find: '', text: 'again' },
    { idea: 1, field: 'personality', action: 'write', find: '', text: 'new personality' },
  ]);
  assert.deepEqual(fill.placed.map((e) => [e.target, e.action, e.start, e.end]), [['mes_example', 'write', 0, 0]]);
  assert.deepEqual(fill.unplaced.map((u) => u.reason), ['this field is already being filled', '"write" only fills an empty field — this one already has text']);
  assert.equal(applyEdits('', fill.placed), '<START>\n{{char}}: "Storm\'s coming."');
  const { buildIdeasPrompts: ideasFor } = await import('../src/improver.js');
  assert.match(ideasFor(card, null).user, /Empty fields you may suggest filling \(kind "extend"\): scenario, mes_example, alternate_greetings\./);
  const { buildScoringPrompts: scoringFor } = await import('../src/scorer.js');
  assert.match(scoringFor(card, undefined, { detail: 'full' }).user, /Empty fields \(not scored, but could be filled\): scenario, mes_example, alternate_greetings\./);
  console.log('✓ empty fields worth filling (examples, alternate greetings, scenario) can be written in one edit — only when really empty, once');

  const echoProvider = {
    name: 'echo', model: 'echo',
    async chat() { return JSON.stringify({ edits: [{ field: 'personality', action: 'replace', find: 'terse', text: 'terse' }], headline: 'nothing' }); },
  };
  await assert.rejects(improveCard(card, critique, echoProvider), /no changes that could be applied[\s\S]*would change nothing/);
  console.log('✓ when no edit can be applied, the reason is reported instead of an empty review');
}

/** Backups exist so a bad write can never be the end of hours of scoring. */
async function testBackups() {
  const { snapshotCache, listBackups, restoreBackup } = await import('../src/backup.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-backup-'));
  const cacheFile = path.join(dir, 'data', 'cache.json');
  await mkdir(path.dirname(cacheFile), { recursive: true });

  const good = { version: 1, charactersDir: '/cards', cards: { 'a.png': { result: { overall_score: 8 } }, 'b.png': { result: { overall_score: 5 } } } };
  await writeFile(cacheFile, JSON.stringify(good));

  const snap = await snapshotCache(cacheFile, { reason: 'startup' });
  assert.ok(snap, 'a non-empty cache should be snapshotted');
  assert.equal(snap.cardCount, 2);

  // an empty cache is not worth a snapshot, and must not push a real one out
  await writeFile(cacheFile, JSON.stringify({ version: 1, cards: {} }));
  assert.equal(await snapshotCache(cacheFile, { reason: 'startup' }), null);

  const list = await listBackups(cacheFile);
  assert.equal(list.length, 1);
  assert.equal(list[0].scoredCount, 2);
  console.log(`✓ the score file is snapshotted before being written (${list[0].cardCount} cards), and an empty cache is not`);

  // the destructive case: the live file gets clobbered, and the backup brings it back
  await writeFile(cacheFile, JSON.stringify({ version: 1, cards: {} }));
  const restored = await restoreBackup(list[0].file, cacheFile);
  assert.equal(restored.cardCount, 2);
  const back = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(Object.keys(back.cards).length, 2);
  assert.equal(back.cards['a.png'].result.overall_score, 8);
  console.log('✓ restoring a backup brings every score back after the live file is wiped');

  // pruning keeps the newest N and no more
  for (let i = 0; i < 5; i++) {
    await writeFile(cacheFile, JSON.stringify({ ...good, marker: i }));
    await snapshotCache(cacheFile, { reason: `run-${i}`, keep: 3 });
  }
  const pruned = await listBackups(cacheFile);
  assert.ok(pruned.length <= 4, `expected pruning to a small set, got ${pruned.length}`);
  console.log(`✓ old snapshots are pruned (kept ${pruned.length}) instead of filling the disk`);

  await rm(dir, { recursive: true, force: true });
}

/**
 * Stopping a scan has to be real: in-flight cards finish and stay saved, cards
 * that never started stay unscored (so "Scan unscored" resumes), and the server
 * keeps running. A 3,000-card run is hours long — being trapped in it is not an
 * acceptable answer.
 */
async function testStopScan() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-stop-'));
  const charactersDir = path.join(dir, 'characters');
  await mkdir(charactersDir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    await writeFile(path.join(charactersDir, `card-${String(i).padStart(2, '0')}.png`), buildFakePng({
      spec: 'chara_card_v2',
      data: { name: `Card ${i}`, description: 'A description long enough to be scorable.', first_mes: 'hi', alternate_greetings: [] },
    }));
  }

  // A deliberately slow API, so the scan is still going when we stop it.
  const slowApi = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          fields: { description: { score: 7, strengths: 's', weaknesses: 'w', suggestions: 'x' } },
          overall_score: 7, top_priority_improvements: [], summary: 's',
        }) }, finish_reason: 'stop' }],
      }));
    }, 300);
  });
  await new Promise((r) => slowApi.listen(0, r));
  const apiPort = slowApi.address().port;

  const { startServer } = await import('../src/server.js');
  const { DEFAULT_WEIGHTS } = await import('../src/scorer.js');
  const server = await startServer({
    charactersDir,
    cacheFile: path.join(dir, 'data', 'cache.json'),
    trashDir: path.join(dir, 'data', 'trash'),
    configPath: path.join(dir, 'config.json'),
    provider: 'openai',
    baseURL: `http://localhost:${apiPort}`,
    apiKey: 'test',
    model: 'test-model',
    concurrency: 2,
    weights: DEFAULT_WEIGHTS,
    port: 4182,
  });

  try {
    const { jobId, total } = await (await fetch('http://localhost:4182/api/score/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    })).json();
    assert.equal(total, 40);

    // let a few land, then stop
    await new Promise((r) => setTimeout(r, 1200));
    const stop = await (await fetch(`http://localhost:4182/api/score/batch/${jobId}/stop`, { method: 'POST' })).json();
    assert.equal(stop.id, jobId);

    let job;
    for (let i = 0; i < 60; i++) {
      job = await (await fetch(`http://localhost:4182/api/score/batch/${jobId}`)).json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(job.status, 'stopped', `expected the job to end as stopped, got ${job.status}`);
    assert.ok(job.done > 0, 'the cards that were in flight should have finished and been kept');
    assert.ok(job.skipped > 0, 'the cards that had not started should be skipped, not scored');
    assert.equal(job.done + job.errors + job.skipped, 40);
    console.log(`✓ stopping a scan keeps the ${job.done} scores already finished and skips the remaining ${job.skipped}`);

    // the scores that landed are on disk, and the rest are still pending work
    const { hashedCacheFileFor } = await import('../src/cachePath.js');
    const cache = JSON.parse(await readFile(hashedCacheFileFor(path.join(dir, 'data', 'cache.json'), charactersDir), 'utf8'));
    assert.equal(Object.keys(cache.cards).length, job.done + job.errors);
    console.log(`✓ every score from the stopped run is saved to disk (${Object.keys(cache.cards).length} entries)`);

    const resume = await (await fetch('http://localhost:4182/api/score/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'unscored' }),
    })).json();
    assert.equal(resume.total, job.skipped + job.errors, '"Scan unscored" should pick up exactly what was left');
    await fetch(`http://localhost:4182/api/score/batch/${resume.jobId}/stop`, { method: 'POST' });
    console.log(`✓ "Scan unscored" resumes with exactly the ${resume.total} cards the stop left behind`);
  } finally {
    server.close();
    slowApi.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Fast triage mode. Scanning time is almost entirely the model writing its
 * answer, so the only real lever on speed is asking it to write less — this
 * checks that fast mode actually does, and that what comes back is still a
 * usable score rather than a degraded one.
 */
async function testFastScoring() {
  const { scoreCard, buildScoringPrompts, FAST_SYSTEM_PROMPT, FULL_SYSTEM_PROMPT } = await import('../src/scorer.js');

  const seen = [];
  const fakeApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((m) => m.role === 'system').content;
      const fast = system === FAST_SYSTEM_PROMPT;
      seen.push({ fast, maxTokens: parsed.max_tokens, systemChars: system.length });
      const content = fast
        ? JSON.stringify({ fields: { description: 8, first_mes: 6 }, overall_score: 7.4 })
        : JSON.stringify({
            fields: {
              description: { score: 8, strengths: 'a'.repeat(70), weaknesses: 'b'.repeat(70), suggestions: 'c'.repeat(70) },
              first_mes: { score: 6, strengths: 'a'.repeat(70), weaknesses: 'b'.repeat(70), suggestions: 'c'.repeat(70) },
            },
            overall_score: 7.4,
            top_priority_improvements: ['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40)],
            summary: 's'.repeat(180),
          });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => fakeApi.listen(0, r));
  const port = fakeApi.address().port;

  const provider = createProvider({ provider: 'openai', baseURL: `http://localhost:${port}`, apiKey: 'test', model: 'test-model' });
  const card = { name: 'Fast Test', fields: { description: 'A description worth scoring.', first_mes: 'Hello {{user}}.' } };

  const full = await scoreCard(card, provider, { detail: 'full' });
  const fast = await scoreCard(card, provider, { detail: 'fast' });
  fakeApi.close();

  assert.equal(fast.fields.description.score, 8, 'fast mode must still produce a per-field score');
  assert.equal(fast.fields.first_mes.score, 6);
  assert.equal(fast.overall_score, 7.4);
  assert.equal(fast.brief, true, 'a fast result must be marked so the UI can offer a full rescore');
  assert.equal(fast.fields.description.strengths, '', 'fast mode returns no critique text');
  assert.equal(full.brief, undefined, 'a full result is not marked brief');
  assert.ok(full.fields.description.strengths.length > 0);
  console.log('✓ fast mode returns real per-field scores and an overall, with no critique text');

  // the actual point: far less for the model to write
  const fullChars = JSON.stringify(full).length;
  const fastChars = JSON.stringify({ fields: { description: 8, first_mes: 6 }, overall_score: 7.4 }).length;
  assert.ok(fullChars > fastChars * 5, `expected the full answer to dwarf the fast one (${fullChars} vs ${fastChars})`);
  // Fast mode gets its speed from asking for less, not from capping the
  // answer: a cap would cut off a thinking model mid-reasoning.
  assert.equal(seen[1].maxTokens, undefined, 'fast mode must not send its own response cap');
  console.log(`✓ fast mode asks the model for ~${(fullChars / fastChars).toFixed(0)}x less output — without capping the response`);

  const fastPrompts = buildScoringPrompts(card, undefined, { detail: 'fast' });
  const fullPrompts = buildScoringPrompts(card, undefined, { detail: 'full' });
  assert.equal(fastPrompts.system, FAST_SYSTEM_PROMPT);
  assert.equal(fullPrompts.system, FULL_SYSTEM_PROMPT);
  assert.match(fastPrompts.user, /### description/, 'scored fields are still presented the same way');

  // A zero-weight field contributes nothing to the overall score, so a
  // scores-only pass should not pay to send it.
  const withGreetings = {
    name: 'Greeting Heavy',
    fields: { description: 'Short description.', alternate_greetings: 'A long alternate greeting. '.repeat(60) },
  };
  const fastG = buildScoringPrompts(withGreetings, undefined, { detail: 'fast' });
  const fullG = buildScoringPrompts(withGreetings, undefined, { detail: 'full' });
  assert.ok(fullG.user.includes('alternate_greetings'), 'full mode still critiques zero-weight fields');
  assert.ok(!fastG.user.includes('alternate_greetings'), 'fast mode skips fields that cannot affect the score');
  assert.ok(fastG.user.length < fullG.user.length / 3,
    `fast prompt should be far smaller (${fastG.user.length} vs ${fullG.user.length} chars)`);
  console.log(`✓ fast mode drops zero-weight fields from the prompt too (${fullG.user.length} → ${fastG.user.length} chars on a greeting-heavy card)`);

  // ...but a card whose only text lives in those fields must still get a score.
  const onlyGreetings = { name: 'Greetings Only', fields: { alternate_greetings: 'The only text this card has.' } };
  const providerForFallback = {
    name: 'stub', model: 'stub',
    async chat({ user }) {
      assert.ok(user.includes('### alternate_greetings'), 'the fallback must send the card it does have');
      return JSON.stringify({ fields: { alternate_greetings: 5 }, overall_score: 5 });
    },
  };
  const fallback = await scoreCard(onlyGreetings, providerForFallback, { detail: 'fast' });
  assert.equal(fallback.overall_score, 5);
  console.log('✓ a card whose only text is in a zero-weight field is still scored, not skipped');
  assert.match(FAST_SYSTEM_PROMPT, /Judge depth, not length/, 'fast mode judges depth, not length — neither long nor short is a virtue');
  assert.match(FAST_SYSTEM_PROMPT, /contradicts the description/, 'and counts contradictions between fields against the card');
  assert.match(FAST_SYSTEM_PROMPT, /Do not be generous/);
  console.log('✓ fast mode keeps the full critique\'s standard: depth not length, contradictions count');
}

/**
 * Cache writes. A full rewrite per card is O(n) per card: at 3,765 cards that
 * is a ~9MB JSON.stringify every time one finishes. Writes are coalesced above
 * a threshold — but a flush must still put everything on disk.
 */
async function testCoalescedWrites() {
  const { Store } = await import('../src/store.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-writes-'));
  const file = path.join(dir, 'cache.json');

  let writes = 0;
  const makeStore = (opts) => {
    const store = new Store(file, '/cards', opts);
    const realSave = store._save.bind(store);
    store._save = async () => { writes++; return realSave(); };
    return store;
  };

  // Small cache: every set is written immediately, because it costs nothing.
  const small = makeStore({ coalesceMs: 50, coalesceAbove: 5 });
  for (let i = 0; i < 4; i++) await small.set(`small-${i}.png`, { result: { overall_score: 5 } });
  assert.equal(writes, 4, 'a small cache should still write after every card');
  console.log('✓ a small cache is written after every card (durability where it is free)');

  // Big cache: a burst of finishing cards collapses into one write.
  writes = 0;
  const big = makeStore({ coalesceMs: 60, coalesceAbove: 5 });
  await big.load();
  for (let i = 0; i < 40; i++) big.set(`big-${i}.png`, { result: { overall_score: 7 } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(writes <= 3, `expected a burst of 40 cards to collapse into a couple of writes, got ${writes}`);
  console.log(`✓ 40 cards finishing together cost ${writes} file write(s) instead of 40`);

  // and nothing is lost: everything staged is on disk after a flush
  for (let i = 0; i < 10; i++) big.set(`late-${i}.png`, { result: { overall_score: 9 } });
  await big.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.keys(onDisk.cards).length, 54, 'every staged card must be on disk after a flush');
  assert.equal(onDisk.cards['late-9.png'].result.overall_score, 9);
  console.log('✓ flush() puts every pending card on disk — a run always ends on one');

  // Bulk delete must not pay a coalescing window per card. Awaiting delete()
  // in a loop once turned "cull 500 bad cards" into a ten-minute wait.
  const bulk = new Store(path.join(dir, 'bulk.json'), '/cards', { coalesceMs: 1200, coalesceAbove: 100 });
  for (let i = 0; i < 1000; i++) bulk.stage(`c${i}.png`, { result: { overall_score: 5 } });
  await bulk.flush();
  const started = Date.now();
  for (let i = 0; i < 500; i++) bulk.stageDelete(`c${i}.png`);
  await bulk.flush();
  const tookMs = Date.now() - started;
  const left = Object.keys(JSON.parse(await readFile(path.join(dir, 'bulk.json'), 'utf8')).cards).length;
  assert.equal(left, 500, 'every deleted entry must be gone from disk');
  assert.ok(tookMs < 2000, `deleting 500 cards should be one write, not 500 (took ${tookMs}ms)`);
  console.log(`✓ deleting 500 cards costs one write (${tookMs}ms), not one coalescing window each`);

  await rm(dir, { recursive: true, force: true });
}

/**
 * Run-level supervision: what a whole scan does when the API misbehaves.
 * Per-request retries existed already; these are the failures that no amount
 * of retrying one request can fix, and that used to quietly ruin a long run.
 */
async function testRunSupervision() {
  const { fatalReason, isConnectivityError } = await import('../src/errorKinds.js');
  const { RateLimiter } = await import('../src/rateLimiter.js');
  const { runQueue } = await import('../src/concurrency.js');

  // --- classification ---
  assert.equal(fatalReason({ status: 401, message: 'x' })?.kind, 'auth');
  assert.equal(fatalReason({ status: 403, message: 'x' })?.kind, 'auth');
  assert.equal(fatalReason({ status: 402, message: 'x' })?.kind, 'credits');
  assert.equal(fatalReason({ status: 400, message: 'API 400', body: '{"error":"Insufficient balance"}' })?.kind, 'credits');
  assert.equal(fatalReason({ status: 404, message: 'API 404', body: 'model not found' })?.kind, 'model');
  assert.equal(fatalReason({ status: 500, message: 'API 500' }), null, 'a server error is not fatal');
  assert.equal(fatalReason({ status: 429, message: 'rate limit' }), null, 'a rate limit is not fatal');
  assert.equal(fatalReason({ status: 429, message: 'API 429', body: 'Quota exceeded: 60 requests per minute' }), null,
    'a per-minute "quota exceeded" is a rate limit, not an empty account');
  assert.equal(fatalReason({ status: 429, message: 'API 429', body: 'You exceeded your current quota, please check your plan and billing details' })?.kind, 'credits',
    'OpenAI\'s out-of-money 429 is recognised as credits');
  assert.equal(isConnectivityError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), true);
  assert.equal(isConnectivityError({ status: 503, message: 'API 503' }), true);
  assert.equal(isConnectivityError({ isTimeout: true, message: 'timed out' }), false, 'a slow model is not an outage');
  assert.equal(isConnectivityError({ status: 500, message: 'API 500' }), false);
  console.log('✓ errors are sorted into "this card", "the whole run is broken" and "the network is down"');

  // --- adaptive pacing ---
  const limiter = new RateLimiter({ requestsPerMinute: 60 });
  limiter.penalize(); limiter.penalize(); limiter.penalize();
  assert.equal(limiter.stats().currentRpm, 30, 'one burst of 429s halves the pace once, not three times');
  limiter.lastPenaltyMs -= 60_000;
  for (let i = 0; i < 200; i++) limiter.reward();
  assert.equal(limiter.stats().currentRpm, 60, 'the pace recovers after a quiet spell');
  assert.equal(limiter.stats().ceilingRpm, 60, 'and never past the configured ceiling');
  const unpaced = new RateLimiter({ requestsPerMinute: 0 });
  unpaced.penalize();
  assert.equal(unpaced.stats().enabled, true, 'a 429 turns pacing on even for a provider with no published limit');
  console.log('✓ a 429 halves the pace for everyone sharing the limiter, and it climbs back once things are quiet');

  // --- queue: requeue + gate ---
  const seen = [];
  let open;
  let gateP = new Promise((r) => { open = r; });
  let firstAttempt = true;
  const queueRun = runQueue(['a', 'b'], 2, async (item, { requeue }) => {
    seen.push(item);
    if (item === 'a' && firstAttempt) { firstAttempt = false; requeue('a'); }
  }, { gate: () => gateP });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, [], 'nothing runs while the gate is closed');
  gateP = null;
  open();
  await queueRun;
  assert.deepEqual(seen.sort(), ['a', 'a', 'b'], 'a requeued item runs again');
  console.log('✓ the work queue holds everything while paused and retries handed-back items');

  // --- end to end, against a fake API that can be switched mid-run ---
  const api = { mode: 'ok', hits: [], flaky: new Map() };
  const OK = (score = 7) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fields: { description: score }, overall_score: score }) } }] });
  const fake = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!b.includes('messages')) { // probe (GET /models)
        if (api.mode === 'down') { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return;
      }
      api.hits.push({ t: Date.now(), mode: api.mode });
      if (api.mode === 'down') { req.socket.destroy(); return; }
      if (api.mode === 'auth') { res.writeHead(401); res.end('{"error":"Invalid API key"}'); return; }
      // A card that times out on both of its request attempts (the request
      // layer already retries a timeout once), then works — exactly the case
      // the run-level retry pass exists for.
      const userText = JSON.parse(b).messages.find((m) => m.role === 'user')?.content || '';
      const name = (userText.match(/Character name: (\S+)/) || [])[1];
      if (api.flaky.get(name) > 0) { api.flaky.set(name, api.flaky.get(name) - 1); return; } // never answers
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(OK()); }, 40);
    });
  });
  await new Promise((r) => fake.listen(0, r));

  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-supervise-'));
  const charactersDir = path.join(dir, 'characters');
  await mkdir(charactersDir, { recursive: true });
  for (let i = 0; i < 30; i++) {
    await writeFile(path.join(charactersDir, `c${String(i).padStart(2, '0')}.png`), buildFakePng({
      spec: 'chara_card_v2', data: { name: `C${String(i).padStart(2, '0')}`, description: 'Scorable text for this card.', alternate_greetings: [] },
    }));
  }
  const { startServer } = await import('../src/server.js');
  const { DEFAULT_WEIGHTS } = await import('../src/scorer.js');
  const server = await startServer({
    charactersDir, cacheFile: path.join(dir, 'data', 'cache.json'), trashDir: path.join(dir, 'data', 'trash'),
    configPath: path.join(dir, 'config.json'), provider: 'openai', baseURL: `http://localhost:${fake.address().port}`,
    apiKey: 'k', model: 'm', concurrency: 3, requestsPerMinute: 0, scoreDetail: 'fast',
    timeoutMs: 600, retryBaseDelayMs: 20, outageProbeMs: 150, weights: DEFAULT_WEIGHTS, port: 4183,
  });
  const base = 'http://localhost:4183';
  const post = async (url, body = {}) => {
    const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const job = async (id) => (await fetch(`${base}/api/score/batch/${id}`)).json();
  const until = async (id, pred, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const j = await job(id);
      if (pred(j)) return j;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting; last state ${JSON.stringify({ status: j.status, state: j.state, done: j.done, errors: j.errors })}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const scoredCount = async () => (await (await fetch(`${base}/api/cards`)).json()).cards.filter((c) => c.overallScore != null).length;

  try {
    // a clean first pass, with one card that times out once and should be
    // picked up by the automatic retry pass rather than left failed
    api.flaky.set('C07', 2);
    const first = await post('/api/score/batch', { scope: 'all' });
    assert.equal(first.status, 200);

    // one scan at a time: a second start attaches to the first
    const second = await post('/api/score/batch', { scope: 'all' });
    assert.equal(second.status, 409, 'a second concurrent scan must be refused');
    assert.equal(second.json.jobId, first.json.jobId, 'and pointed at the scan already running');
    const active = await (await fetch(`${base}/api/score/active`)).json();
    assert.equal(active.jobId, first.json.jobId, 'a reloaded page can find the running scan');
    console.log('✓ a second scan is refused and pointed at the running one; a reloaded page can find it');

    const firstDone = await until(first.json.jobId, (j) => j.status !== 'running');
    assert.equal(firstDone.done, 30);
    assert.equal(firstDone.errors, 0, `the flaky card should have been recovered, got ${firstDone.errors} failed`);
    assert.equal(firstDone.recovered, 1);
    console.log('✓ a card that timed out on both attempts is recovered by the automatic retry pass — the run ends 30/30, 0 failed');

    // the key dies during a rescore: existing scores must survive, the scan
    // must pause instead of failing everything, and Resume must finish it
    api.mode = 'auth';
    const switchAt = Date.now();
    const rescore = await post('/api/score/batch', { scope: 'all', rescore: true });
    const paused = await until(rescore.json.jobId, (j) => j.state === 'paused');
    await new Promise((r) => setTimeout(r, 400));
    const sentAfter = api.hits.filter((h) => h.t >= switchAt).length;
    assert.equal(paused.pauseKind, 'auth');
    assert.equal(paused.errors, 0, 'a rejected key is not 30 failed cards');
    assert.ok(sentAfter <= 6, `requests should stop almost immediately once the key is rejected (sent ${sentAfter})`);
    assert.equal(await scoredCount(), 30, 'a rescore that cannot run must not wipe the existing scores');
    console.log(`✓ a rejected key pauses the scan after ${sentAfter} request(s): 0 cards failed, all 30 existing scores intact`);

    api.mode = 'ok';
    const resumed = await post(`/api/score/batch/${rescore.json.jobId}/resume`);
    assert.equal(resumed.status, 200);
    const afterResume = await until(rescore.json.jobId, (j) => j.status !== 'running');
    assert.equal(afterResume.done, 30);
    assert.equal(afterResume.errors, 0);
    console.log('✓ after fixing the key, Resume finishes the scan with nothing lost or double-counted');

    // an outage mid-scan: wait, don't fail cards, carry on alone
    const outageRun = await post('/api/score/batch', { scope: 'all', rescore: true });
    await until(outageRun.json.jobId, (j) => j.done >= 5);
    api.mode = 'down';
    const waiting = await until(outageRun.json.jobId, (j) => j.state === 'waiting');
    assert.equal(waiting.state, 'waiting');
    await new Promise((r) => setTimeout(r, 600));
    api.mode = 'ok';
    const afterOutage = await until(outageRun.json.jobId, (j) => j.status !== 'running', 30000);
    assert.equal(afterOutage.errors, 0, `an outage must not mark cards failed (got ${afterOutage.errors})`);
    assert.equal(afterOutage.done, 30);
    assert.ok(afterOutage.outages >= 1);
    console.log('✓ a network outage puts the scan into "waiting", it resumes by itself, and 0 cards are marked failed');

    // stop works from a paused state too
    api.mode = 'auth';
    const stuck = await post('/api/score/batch', { scope: 'all', rescore: true });
    await until(stuck.json.jobId, (j) => j.state === 'paused');
    await post(`/api/score/batch/${stuck.json.jobId}/stop`);
    const stopped = await until(stuck.json.jobId, (j) => j.status !== 'running');
    assert.equal(stopped.status, 'stopped');
    api.mode = 'ok';
    console.log('✓ Stop works while paused, and a stopped scan frees the slot for the next one');
  } finally {
    server.close();
    fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Editable prompts. The instructions are yours to change; the response format
 * the parser depends on is locked and always appended, so no edit can turn a
 * 3,000-card scan into 3,000 parse failures.
 */
async function testEditablePrompts() {
  const P = await import('../src/prompts.js');
  const { scoreCard, FULL_SYSTEM_PROMPT } = await import('../src/scorer.js');

  assert.equal(P.systemPrompt('full', {}), FULL_SYSTEM_PROMPT, 'with no edits, the prompt is exactly the one always sent');
  console.log('✓ with no edits, every prompt is byte-for-byte what was sent before');

  const custom = { full: 'Grade like a strict horror-fiction editor. Atmosphere matters most.' };
  const sent = P.systemPrompt('full', custom);
  assert.ok(sent.startsWith(custom.full), 'the edited instructions are what the model reads first');
  assert.ok(sent.includes(P.PROMPT_KINDS.full.format), 'the locked response format is always appended');
  assert.notEqual(P.promptHash(sent), P.promptHash(FULL_SYSTEM_PROMPT), 'a changed prompt has a different fingerprint');
  console.log('✓ an edit replaces the instructions only; the response format is still appended');

  assert.ok(P.validateInstructions('full', '   ').length > 0, 'empty instructions are refused');
  assert.ok(P.validateInstructions('full', 'x'.repeat(P.MAX_INSTRUCTIONS_CHARS + 1)).length > 0, 'runaway length is refused');
  assert.ok(P.adviseInstructions('full', 'Reply as {"fields": ...}').length > 0, 'describing JSON yourself earns a warning');
  assert.ok(P.adviseInstructions('fast', 'Also explain the weaknesses.').length > 0, 'asking fast mode for prose earns a warning');
  const lenient = (t) => P.adviseInstructions('fast', t).some((a) => /Lenient/.test(a));
  assert.equal(lenient(P.PROMPT_KINDS.fast.defaultInstructions), false, 'the built-in strict prompt must not be flagged as lenient');
  assert.equal(lenient('Do not be generous.'), false);
  assert.equal(lenient('Be generous with scores.'), true);
  console.log('✓ empty or runaway instructions are refused; conflicting ones get a warning (and "do not be generous" is not lenient)');

  // The parser keeps working whatever the instructions say.
  const seen = [];
  const provider = {
    name: 'stub', model: 'stub',
    async chat({ system }) {
      seen.push(system);
      return JSON.stringify({ fields: { description: 3 }, overall_score: 3 });
    },
  };
  const card = { name: 'Prompted', fields: { description: 'Some text.' } };
  const r = await scoreCard(card, provider, { detail: 'fast', prompts: { fast: 'Be extremely harsh about clichés.' } });
  assert.ok(seen[0].startsWith('Be extremely harsh about clichés.'));
  assert.equal(r.overall_score, 3);
  assert.equal(r.promptHash, P.promptHash(seen[0]), 'each score records the prompt that produced it');
  console.log('✓ scores made with an edited prompt parse normally and record which prompt made them');
}

/**
 * Rate → ideas → rewrite-only-what-you-chose. The point is control over what
 * changes, so this checks what reaches the model, what is thrown away, and
 * what ends up in the file — not just that something comes back.
 */
async function testIdeasThenRewrite() {
  const { generateIdeas, improveCard } = await import('../src/improver.js');
  const { extractCardFromPng } = await import('../src/cardParser.js');

  const OLD_LOOK = 'Wren is 8 feet tall with a red coat.';
  const raw = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: 'Wren', description: 'Wren keeps a lighthouse. She is 180 cm tall and wears a grey oilskin coat. ' + 'The old harbour has a long history of wrecks and smugglers. '.repeat(8),
      personality: 'Dry, watchful.', scenario: '', first_mes: '*Wren, all eight feet of her, squints at you.* "Storm\'s coming, {{user}}."',
      mes_example: '', system_prompt: 'Always stay in character.', post_history_instructions: '', alternate_greetings: [],
      creator_notes: 'Made by Anon. Use with a fantasy preset.',
      character_book: { entries: [
        { id: 1, keys: ['Wren', 'appearance'], comment: 'Wren Appearance', content: OLD_LOOK, extensions: {}, enabled: true, insertion_order: 6 },
      ], extensions: {} },
      extensions: { depth_prompt: { depth: 4, prompt: 'Write in third person. Keep replies under 300 words.', role: 'system' } },
    },
  };
  const parsed = extractCardFromPng(buildFakePng(raw));
  assert.equal(parsed.fields.character_note, 'Write in third person. Keep replies under 300 words.', "the Character's Note is read as a field");

  // --- ideas: checked against the card ---
  let seenIdeasPrompt = '';
  const ideasProvider = {
    name: 'stub', model: 'stub',
    async chat({ user }) {
      seenIdeasPrompt = user;
      return JSON.stringify({
        canon: [
          { aspect: 'look', fact: '180 cm tall', quote: 'She is 180 cm tall' },
          { aspect: 'voice', fact: 'Clipped warnings', quote: 'Storm\'s coming, {{user}}.' },
          { aspect: 'look', fact: 'Made-up fact', quote: 'a line that is not in the card at all' },
          { aspect: 'nonsense', fact: 'Lighthouse keeper', quote: '' },
        ],
        ideas: [
          { kind: 'fix', field: 'first_mes', title: 'Greeting height matches', change: 'Change "all eight feet of her" to match 180 cm.', why: 'Contradiction.', quotes: ['all eight feet of her', 'She is 180 cm tall', 'not really in the card'], impact: 'HIGH', risk: 'none' },
          { kind: 'combine', field: 'description', title: 'One line for the harbour', change: 'Merge the repeated harbour history.', why: 'Said eight times.', quotes: [], impact: 'high', risk: 'none' },
          { kind: 'lorebook', field: 'lorebook:0', title: 'Merge appearance entries', change: 'x', impact: 'high' },
          { kind: 'move', field: 'description', title: 'Move harbour lore out', change: 'Move the wreck history to the lorebook.', impact: 'medium' },
          { field: 'not_a_field', title: 'Bogus', change: 'x', impact: 'low' },
        ],
      });
    },
  };
  const ideas = await generateIdeas(parsed, null, ideasProvider);
  assert.ok(!seenIdeasPrompt.includes('Made by Anon'), 'creator notes are not the card and must not be sent');
  assert.ok(!seenIdeasPrompt.includes(OLD_LOOK) && !/lorebook/i.test(seenIdeasPrompt), 'card only: the lorebook is not sent');
  assert.ok(seenIdeasPrompt.includes('### character_note'), "the Character's Note is part of the card");
  assert.doesNotMatch(seenIdeasPrompt, /tokens/, 'no token counts — quality, not size');
  assert.deepEqual(ideas.ideas.map((i) => i.kind), ['fix', 'combine'], 'lorebook and move ideas, and unknown fields, are dropped');
  assert.equal(ideas.ideas[0].impact, 'high');
  assert.deepEqual(ideas.ideas[0].quotes, ['all eight feet of her', 'She is 180 cm tall'], 'quotes not really in the card are dropped');
  assert.deepEqual(ideas.canon.map((c) => [c.aspect, c.quote]), [
    ['look', 'She is 180 cm tall'], ['voice', 'Storm\'s coming, {{user}}.'], ['look', ''], ['other', ''],
  ], 'a canon fact keeps its quote only if the quote is really in the card');
  assert.deepEqual(ideas.keepQuotes, ['She is 180 cm tall', 'Storm\'s coming, {{user}}.']);
  console.log('✓ ideas are card only, with kinds and quotes checked against the card; the canon keeps only real quotes; creator notes and lorebook are not sent');

  // Creator notes are the creator's profile blurb, credits and links — not the
  // character. No prompt may include them: not scoring, not either improve step.
  // And the review is card only: the lorebook isn't sent anywhere either.
  const { buildScoringPrompts } = await import('../src/scorer.js');
  const { buildIdeasPrompts, buildImprovePrompts } = await import('../src/improver.js');
  const everyPrompt = [
    buildScoringPrompts(parsed, undefined, { detail: 'full' }),
    buildScoringPrompts(parsed, undefined, { detail: 'fast' }),
    buildIdeasPrompts(parsed, null),
    buildImprovePrompts(parsed, null),
  ];
  assert.ok(everyPrompt.every((p) => !(p.system + p.user).includes('Made by Anon')),
    'creator notes must never reach the model, for scoring or improving');
  assert.ok(everyPrompt.every((p) => !(p.system + p.user).includes(OLD_LOOK) && !/lorebook/i.test(p.system + p.user)),
    'the lorebook is not part of any review or improve prompt');
  assert.ok(everyPrompt.every((p) => !/~\d+ tokens/.test(p.user)), 'no token counts next to fields');
  assert.match(everyPrompt[0].system, /WHAT A 10\/10 CARD DOES/);
  console.log('✓ every prompt is the card only — no creator notes, no lorebook, no token counts — and the critique scores against a 10/10 bar');

  const v1 = extractCardFromPng(buildFakePng({ name: 'Flat', description: 'x '.repeat(80), first_mes: 'hi' }));
  const v1prompt = buildIdeasPrompts(v1, null);
  assert.ok(!v1prompt.user.includes('### character_note'), 'a V1 card has no Character\'s Note to edit');

  // --- edits: only what the chosen ideas are about ---
  let seenEditPrompt = '';
  const editProvider = {
    name: 'stub', model: 'stub',
    async chat({ user }) {
      seenEditPrompt = user;
      return JSON.stringify({
        edits: [
          { idea: 1, field: 'first_mes', action: 'replace', find: 'all eight feet of her', text: 'all 180 cm of her', why: 'Match the canon height.' },
          { idea: 1, field: 'description', action: 'replace', find: 'She is 180 cm tall', text: 'She is 8 feet tall', why: 'Nobody asked.' },
          { idea: 1, field: 'personality', action: 'replace', find: 'Dry, watchful.', text: 'TOTALLY DIFFERENT', why: 'Nobody asked.' },
          { idea: 1, field: 'lorebook:0', action: 'disable', find: '', text: '', why: 'Not here.' },
        ],
        new_lorebook_entries: [{ keys: ['harbour'], content: 'Unasked-for entry.' }],
        headline: 'Fixed the height.',
      });
    },
  };
  const canon = ideas.canon.filter((c) => c.quote);
  const plan = { ideas: ideas.ideas.slice(0, 1), canon, keepQuotes: ideas.keepQuotes };
  const proposal = await improveCard(parsed, null, editProvider, { plan });
  assert.ok(seenEditPrompt.includes('### first_mes'), 'the field the fix is about is sent');
  assert.ok(seenEditPrompt.includes('### description (REFERENCE ONLY'), 'the description is the reference, not an edit target');
  assert.ok(!seenEditPrompt.includes('### personality'), 'fields nobody chose a change for are not sent');
  assert.match(seenEditPrompt, /Canon — what makes this character itself[\s\S]*look: 180 cm tall \(“She is 180 cm tall”\)/);
  assert.deepEqual(proposal.edits.map((e) => `${e.action}@${e.target}`), ['replace@first_mes']);
  assert.deepEqual(proposal.unplaced.map((u) => u.target), ['description', 'personality', 'lorebook:0'], 'edits outside the chosen ideas, or outside the card, are refused');
  assert.equal(proposal.lorebookEntries, undefined, 'no lorebook entries come back');
  assert.ok(proposal.rest.includes('Dry, watchful.') && !proposal.rest.includes(OLD_LOOK), 'the rest of the card (card only) comes back for the detail check');
  console.log('✓ the edits stay inside the chosen ideas and the card: the greeting fix goes through; the description, an unchosen field and the lorebook are refused');
}

/** Saving edits: the Character's Note, and the flat copy SillyTavern's JSON exports carry. */
async function testWriterNoteAndFlatCopy() {
  const { applyFieldsToRaw } = await import('../src/cardWriter.js');
  const raw = {
    name: 'Wren', description: 'old', first_mes: 'hi', character_book: { entries: [{ content: 'A' }] },
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: 'Wren', description: 'old', first_mes: 'hi', alternate_greetings: [], extensions: { depth_prompt: { depth: 2, prompt: 'p', role: 'system' }, custom: 1 },
      character_book: { entries: [{ id: 1, content: 'A', keys: ['a'], extensions: { keep: 1 } }], extensions: {} },
    },
  };
  const out = applyFieldsToRaw(raw, { fields: { description: 'new', character_note: 'Write in third person.' } });
  assert.equal(out.data.description, 'new');
  assert.equal(out.description, 'new', 'the flat top-level copy SillyTavern exports is kept in step');
  assert.equal(out.first_mes, 'hi');
  assert.deepEqual(out.data.extensions.depth_prompt, { depth: 2, prompt: 'Write in third person.', role: 'system' }, "the note's depth and role are kept");
  assert.equal(out.data.extensions.custom, 1);
  assert.deepEqual(out.data.character_book, raw.data.character_book, 'the lorebook is untouched');
  assert.deepEqual(out.character_book, raw.character_book);
  assert.equal(raw.data.description, 'old', 'the original object is not mutated');
  assert.throws(() => applyFieldsToRaw({ name: 'Flat', description: 'd' }, { fields: { character_note: 'x' } }), /V1 format/);
  console.log("✓ saving writes the Character's Note (keeping its depth and role), keeps SillyTavern's flat copy in step, and leaves the lorebook alone");
}

/**
 * The review step's live checks (public/cardEdits.js), loaded the way the page
 * loads them. The point of the whole design: a change that would remove a
 * detail found nowhere else starts OFF; a merge, a move or a fix does not.
 */
async function testCardEditsReview() {
  const vm = await import('node:vm');
  const box = {};
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(await readFile(path.join(PROJECT_ROOT, 'public/cardEdits.js'), 'utf8'), box);
  const C = box.CardEdits;

  const desc = 'Wren keeps the lighthouse. She wears a long grey oilskin coat with brass buttons and a red wool scarf. She is quiet. She trusts the sea. She is quiet and watchful.';
  const at = (s, find) => ({ start: desc.indexOf(find), end: desc.indexOf(find) + find.length, old: find });
  const part = {
    target: 'description', before: desc, handEdited: false,
    edits: [
      // The trim that kills the character: the outfit loses its details.
      { ...at(desc, 'She wears a long grey oilskin coat with brass buttons and a red wool scarf.'), action: 'replace', new: 'She wears a grey coat.', kind: 'trim', order: 0 },
      // A combine: two "quiet" sentences become one that keeps both details.
      { ...at(desc, 'She is quiet. '), action: 'replace', new: '', kind: 'combine', order: 1 },
      { ...at(desc, 'She is quiet and watchful.'), action: 'replace', new: 'She is quiet and watchful, and listens more than she speaks.', kind: 'combine', order: 2 },
      // An extension: adds only.
      { start: desc.indexOf('She trusts the sea.') + 19, end: desc.indexOf('She trusts the sea.') + 19, old: '', action: 'insert_after', new: ' She talks to the gulls.', kind: 'extend', order: 3 },
    ],
  };
  const greeting = '*Wren, all 8 feet of her, looks up.*';
  const fix = { target: 'first_mes', before: greeting, handEdited: false, edits: [
    { start: 6, end: 23, old: 'all 8 feet of her', action: 'replace', new: 'all 180 cm of her', kind: 'fix', order: 0 },
  ] };
  const parts = [part, fix];
  C.defaultUses(parts, 'Wren is 180 cm tall.');
  assert.deepEqual(part.edits.map((e) => e.use), [false, true, true, true], 'only the outfit trim starts off');
  assert.equal(fix.edits[0].use, true, 'a fix starts on — changing that detail is its point');
  part.edits[0].use = true; // judged as if it were on, like the page does
  const lost = C.lostDetails(part.edits[0].old, C.wholeCard(parts, ''));
  part.edits[0].use = false;
  for (const t of ['oilskin', 'brass', 'buttons', 'red', 'wool', 'scarf']) assert.ok(lost.includes(t), `the check names what the trim would remove: ${t}`);
  assert.ok(!lost.includes('grey'), 'a detail still in the card is not reported lost');
  console.log(`✓ a change that would remove details starts off and names them (${lost.join(', ')}); merges, additions and fixes start on`);

  part.edits[0].use = false;
  const final = C.compose(part.before, part.edits);
  assert.equal(final, 'Wren keeps the lighthouse. She wears a long grey oilskin coat with brass buttons and a red wool scarf. She trusts the sea. She talks to the gulls. She is quiet and watchful, and listens more than she speaks.');
  const sp = C.spans(part.before, part.edits);
  assert.equal(sp.old.map((x) => x.text).join(''), part.before, 'the "card now" column is exactly the original');
  assert.equal(sp.new.map((x) => x.text).join(''), final, 'the "after" column is exactly what will be saved');
  console.log('✓ the final text is the original with exactly the allowed changes; the side-by-side columns match both');
}

/**
 * The comparison behind "allow each change". It runs in the browser, so it's
 * loaded here the way the page loads it — as a plain script — in a sandbox.
 */
async function testChangePicker() {
  const vm = await import('node:vm');
  const box = {};
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(await readFile(path.join(PROJECT_ROOT, 'public/textDiff.js'), 'utf8'), box);
  const T = box.TextDiff;

  const awkward = [
    'Wren is tall. She wears a coat!\n\n*She looks up.* "Storm\'s coming, {{user}}." Then nothing…',
    '[Wren: personality("dry" + "watchful"); clothes("grey coat")]\n[Wren: likes("tea")]',
    'Mr. Smith arrived. 3.5 metres?! Yes.', '', 'no terminators at all',
  ];
  for (const t of awkward) assert.equal(T.splitUnits(t).join(''), t, `splitting must not lose text: ${JSON.stringify(t)}`);
  console.log('✓ the comparison splits text into sentences without losing a single character');

  // The case that motivated it: trim body + outfit, but keep the outfit.
  const before = 'Wren keeps the lighthouse. She is tall, lean and weathered, with salt-white hair. She wears a long grey oilskin coat with brass buttons and a red wool scarf. She is very very mysterious and also mysterious. She trusts the sea.';
  const after = 'Wren keeps the lighthouse. She is tall and weathered. She wears a grey coat. She trusts the sea.';
  const parts = T.diffText(before, after);
  assert.equal(T.changeCount(parts), 3, 'body trim, outfit trim and filler removal are three separate choices');
  const keepOutfit = T.compose(parts, ['new', 'old', 'new'], { before, after });
  assert.equal(keepOutfit, 'Wren keeps the lighthouse. She is tall and weathered. She wears a long grey oilskin coat with brass buttons and a red wool scarf. She trusts the sea.');
  assert.equal(T.compose(parts, ['new', 'new', 'new'], { before, after }), after, 'allowing everything gives exactly the suggestion');
  assert.equal(T.compose(parts, ['old', 'old', 'old'], { before, after }), before, 'allowing nothing gives exactly the original');
  console.log('✓ each changed sentence is its own choice — keep the outfit, take the rest — and all/none reproduce each version exactly');

  // Randomised: any mix of choices yields text made only of original or
  // suggested sentences — never a garbled blend.
  const pool = ['She hums at the lamp.', 'Gulls follow her boat.', 'Her coat is grey.', 'She hates small talk.',
    'The keeper drinks black tea.', 'Storms do not scare her.', 'She counts ships at dawn.', '"Get inside, {{user}}."'];
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let trial = 0; trial < 300; trial++) {
    const a = Array.from({ length: 3 + rand(5) }, () => pool[rand(pool.length)]);
    const b = a.filter(() => rand(4) !== 0).map((x) => (rand(3) === 0 ? x.replace(/\.$/, ', mostly.') : x));
    if (rand(2)) b.splice(rand(b.length + 1), 0, pool[rand(pool.length)]);
    const A = a.join(' ');
    const B = b.join(' ');
    const ps = T.diffText(A, B);
    const n = T.changeCount(ps);
    assert.equal(T.compose(ps, Array(n).fill('new'), { before: A, after: B }), B);
    assert.equal(T.compose(ps, Array(n).fill('old'), { before: A, after: B }), A);
    const mixed = T.compose(ps, Array.from({ length: n }, () => (rand(2) ? 'new' : 'old')));
    const allowed = new Set([...T.splitUnits(A), ...T.splitUnits(B)].map((u) => u.trim()));
    for (const u of T.splitUnits(mixed)) assert.ok(allowed.has(u.trim()), `trial ${trial}: "${u}" is neither original nor suggested`);
  }
  console.log('✓ 300 random edits: every mix of allowed and kept changes is clean text from one version or the other');
}

/**
 * Fast score everything, then Full critique only what still lacks a critique —
 * each scan's kind decided by the request, never by the Settings default. And
 * a prompt test hands back the model's replies exactly as they arrived.
 */
async function testTwoPassAndRawReplies() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sillyscore-twopass-'));
  const charactersDir = path.join(dir, 'characters');
  await mkdir(charactersDir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(charactersDir, `card-${i}.png`), buildFakePng({
      spec: 'chara_card_v2',
      data: { name: `Card ${i}`, description: 'A description long enough to be scorable.', first_mes: 'hi', alternate_greetings: [] },
    }));
  }
  const seen = [];
  let unreadable = false;
  const fakeApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const system = parsed.messages.find((m) => m.role === 'system').content;
      const fast = /Output nothing else — no strengths/.test(system);
      seen.push(fast ? 'fast' : 'full');
      const content = unreadable ? 'I would rate this card a 6 out of 10.'
        : fast ? JSON.stringify({ fields: { description: 5 }, overall_score: 5 })
          : `<think>{{user}} and {{char}}</think>${JSON.stringify({
            fields: { description: { score: 6, strengths: 's', weaknesses: 'w', suggestions: 'x' } },
            overall_score: 6, top_priority_improvements: [], summary: 's',
          })}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content, reasoning_content: fast ? 'separate thoughts' : undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => fakeApi.listen(0, r));

  const { startServer } = await import('../src/server.js');
  const { DEFAULT_WEIGHTS } = await import('../src/scorer.js');
  const server = await startServer({
    charactersDir,
    cacheFile: path.join(dir, 'data', 'cache.json'),
    trashDir: path.join(dir, 'data', 'trash'),
    configPath: path.join(dir, 'config.json'),
    provider: 'openai', baseURL: `http://localhost:${fakeApi.address().port}`, apiKey: 'test', model: 'test-model',
    concurrency: 3, weights: DEFAULT_WEIGHTS, port: 4189, retryBaseDelayMs: 10,
    scoreDetail: 'full', // the default says full; the fast pass must still be fast
  });
  const base = 'http://localhost:4189';
  const post = async (url, body) => (await fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const finish = async (jobId) => {
    for (let i = 0; i < 100; i++) {
      const job = await (await fetch(`${base}/api/score/batch/${jobId}`)).json();
      if (job.status !== 'running') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('scan never finished');
  };

  try {
    let job = await finish((await post('/api/score/batch', { scope: 'unscored', detail: 'fast' })).jobId);
    assert.equal(job.done, 6);
    assert.deepEqual([...new Set(seen.splice(0))], ['fast']);

    // one card already has its critique; the second pass must skip it
    await post('/api/cards/card-0.png/score', { detail: 'full' });
    seen.length = 0;
    job = await finish((await post('/api/score/batch', { scope: 'uncritiqued', rescore: true, detail: 'full' })).jobId);
    assert.equal(job.total, 5, 'only the cards still without a critique');
    assert.deepEqual([...new Set(seen.splice(0))], ['full']);
    const again = await post('/api/score/batch', { scope: 'uncritiqued', rescore: true, detail: 'full' });
    assert.equal(again.total, 0, 'a second Full critique has nothing left to do');
    await finish(again.jobId);
    const { cards } = await (await fetch(`${base}/api/cards`)).json();
    assert.ok(cards.every((c) => c.overallScore === 6 && !c.brief));
    console.log('✓ Fast score then Full critique: the second pass critiques only the 5 cards without one, then has nothing left');

    // "Update old scores": after the prompts change, every stale score is
    // redone the way it was made — fast stays fast, full stays full.
    await post('/api/cards/card-2.png/score', { detail: 'fast' });
    for (const kind of ['fast', 'full']) {
      const { PROMPT_KINDS } = await import('../src/prompts.js');
      await post('/api/prompts', { kind, instructions: `${PROMPT_KINDS[kind].defaultInstructions}\nBe exacting.` });
    }
    let listed = (await (await fetch(`${base}/api/cards`)).json()).cards;
    assert.equal(listed.filter((c) => c.promptStale).length, 6, 'changing the prompts marks every score as made with an older prompt');
    seen.length = 0;
    const upd = await post('/api/score/batch', { scope: 'stale', rescore: true, detail: 'same' });
    assert.equal(upd.total, 6);
    await finish(upd.jobId);
    assert.deepEqual(seen.slice().sort(), ['fast', 'full', 'full', 'full', 'full', 'full'], 'one fast card redone fast, five full critiques redone full');
    listed = (await (await fetch(`${base}/api/cards`)).json()).cards;
    assert.equal(listed.filter((c) => c.promptStale).length, 0, 'nothing left on an older prompt');
    assert.equal(listed.find((c) => c.id === 'card-2.png').brief, true, 'the fast-scored card is still a fast score');
    const again2 = await post('/api/score/batch', { scope: 'stale', rescore: true, detail: 'same' });
    assert.equal(again2.total, 0, 'pressing it again has nothing to do');
    await finish(again2.jobId);
    for (const kind of ['fast', 'full']) await post('/api/prompts', { kind, reset: true });
    console.log('✓ "Update old scores" redoes every stale score the way it was made (fast stays fast, full stays full), then has nothing left');

    // the prompt test shows what came back — on success and on an unreadable answer
    const ok = await post('/api/prompts/test', { kind: 'fast', cardId: 'card-1.png' });
    assert.equal(ok.replies.length, 1);
    assert.equal(ok.replies[0].reasoning, 'separate thoughts');
    assert.equal(ok.replies[0].finishReason, 'stop');
    assert.equal(ok.replies[0].usage.prompt_tokens, 100);
    const full = await post('/api/prompts/test', { kind: 'full', cardId: 'card-1.png' });
    assert.match(full.replies[0].content, /^<think>\{\{user\}\}/, 'the raw answer, thinking included, exactly as received');
    unreadable = true;
    const bad = await (await fetch(`${base}/api/prompts/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fast', cardId: 'card-1.png' }),
    })).json();
    assert.ok(bad.error);
    assert.equal(bad.replies.length, 2, 'both attempts are shown when the answer could not be read');
    assert.match(bad.replies[1].content, /rate this card a 6/);
    console.log('✓ a prompt test returns each raw reply (thinking, finish reason, tokens) — including both failed attempts');
  } finally {
    server.close();
    fakeApi.close();
  }
}

main().catch((err) => {
  console.error('SELF-TEST FAILED:', err);
  process.exitCode = 1;
});
