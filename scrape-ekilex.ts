#!/usr/bin/env bun
// Fetch every Estonian word from the Ekilex `eki` dataset and save the full
// /word/details/{id}/eki payload to disk. Resumable: re-running skips word
// files already present.
//
// The `eki` index returns ~428k entries, but only ~177k are Estonian
// (lang:"est"); the rest are translations/related words from other languages.
// By default we crawl only Estonian; set EKILEX_LANG=all to crawl everything,
// or EKILEX_LANG=rus,ukr to crawl specific languages.
//
// Usage:
//   EKILEX_API_KEY=<32-hex-key> bun run scripts/scrape-ekilex.ts
//
// Output layout (under DATA_DIR):
//   public_word_eki.json   - raw response of /public_word/eki
//   words/<shard>/<id>.json - per-word /word/details/<id>/eki response
//   failed.jsonl           - append-only log of failed ids with reason

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const API_KEY = process.env.EKILEX_API_KEY;
if (!API_KEY) {
  console.error('EKILEX_API_KEY env var is required.');
  process.exit(1);
}

const BASE = 'https://ekilex.ee/api';
const DATA_DIR = 'data/ekilex';
const INDEX_FILE = `${DATA_DIR}/public_word_eki.json`;
const WORDS_DIR = `${DATA_DIR}/words`;
const FAILED_LOG = `${DATA_DIR}/failed.jsonl`;

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const MAX_RETRIES = 4;
const LANG_FILTER = (process.env.EKILEX_LANG ?? 'est').toLowerCase();

async function apiGet(path: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { 'ekilex-api-key': API_KEY! },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        // 4xx (other than 429) is not retried.
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastError = e;
      if (attempt === MAX_RETRIES) break;
      const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await Bun.sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function shardPath(wordId: number): string {
  // Shard by floor(id / 1000) so each directory holds ~1000 files.
  const shard = String(Math.floor(wordId / 1000)).padStart(4, '0');
  return `${WORDS_DIR}/${shard}/${wordId}.json`;
}

interface PublicWordEntry {
  wordId: number;
  lang: string;
}

function extractEntries(payload: unknown): PublicWordEntry[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      `Unexpected /public_word/eki shape: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  const out: PublicWordEntry[] = [];
  for (const entry of payload) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as PublicWordEntry).wordId === 'number' &&
      typeof (entry as PublicWordEntry).lang === 'string'
    ) {
      out.push(entry as PublicWordEntry);
    }
  }
  return out;
}

function filterByLang(entries: PublicWordEntry[]): PublicWordEntry[] {
  if (LANG_FILTER === 'all' || LANG_FILTER === '') return entries;
  const wanted = new Set(LANG_FILTER.split(',').map((s) => s.trim()));
  return entries.filter((e) => wanted.has(e.lang));
}

function langBreakdown(entries: PublicWordEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.lang, (counts.get(e.lang) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v.toLocaleString()}`)
    .join(' ');
}

async function ensureIndex(): Promise<PublicWordEntry[]> {
  const file = Bun.file(INDEX_FILE);
  if (await file.exists()) {
    console.log(`Index cached at ${INDEX_FILE}`);
    return extractEntries(await file.json());
  }
  console.log('Fetching /public_word/eki ...');
  const payload = await apiGet('/public_word/eki');
  await ensureDir(INDEX_FILE);
  await Bun.write(INDEX_FILE, JSON.stringify(payload));
  return extractEntries(payload);
}

async function fetchWord(
  wordId: number,
): Promise<'skipped' | 'fetched' | { error: string }> {
  const out = shardPath(wordId);
  if (await Bun.file(out).exists()) return 'skipped';
  try {
    const data = await apiGet(`/word/details/${wordId}/eki`);
    await ensureDir(out);
    await Bun.write(out, JSON.stringify(data));
    return 'fetched';
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${r}s`;
  return `${r}s`;
}

async function main() {
  const allEntries = await ensureIndex();
  console.log(
    `  total=${allEntries.length.toLocaleString()} (${langBreakdown(allEntries)})`,
  );

  const entries = filterByLang(allEntries);
  console.log(
    `  crawling lang=${LANG_FILTER}: ${entries.length.toLocaleString()} entries`,
  );

  await ensureDir(`${WORDS_DIR}/.keep`);
  await ensureDir(FAILED_LOG);

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const start = Date.now();
  const total = entries.length;

  await runPool(
    entries,
    async (entry) => {
      const wordId = entry.wordId;
      const result = await fetchWord(wordId);
      if (result === 'skipped') skipped++;
      else if (result === 'fetched') fetched++;
      else {
        failed++;
        await appendFile(
          FAILED_LOG,
          JSON.stringify({ wordId, error: result.error, ts: Date.now() }) + '\n',
        );
      }
      const done = fetched + skipped + failed;
      if (done % 250 === 0 || done === total) {
        const elapsed = (Date.now() - start) / 1000;
        const recent = fetched + failed;
        const rate = recent > 0 ? recent / elapsed : 0;
        const eta = rate > 0 ? (total - done) / rate : Infinity;
        console.log(
          `[${done.toLocaleString()}/${total.toLocaleString()}] ` +
            `fetched=${fetched} skipped=${skipped} failed=${failed} ` +
            `· ${rate.toFixed(1)}/s · ETA ${formatDuration(eta)}`,
        );
      }
    },
    CONCURRENCY,
  );

  console.log(
    `Done. fetched=${fetched} skipped=${skipped} failed=${failed} in ${formatDuration((Date.now() - start) / 1000)}.`,
  );
  if (failed > 0) {
    console.log(`See ${FAILED_LOG} for details.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
