#!/usr/bin/env bun
// Build the Kobo dictionary zip from scraped Ekilex data.
//
// Steps:
//   1. Walk every saved /word/details JSON under <cache>/ekilex/words, filter
//      to Estonian (lang:"est"), and emit a single dictgen .df file with one
//      entry per word.
//   2. Run dictgen to produce <cache>/dicthtml-et.zip.
//   3. Bundle the LICENSE file (CC BY 4.0 attribution + modifications
//      description) into the zip.
//
// Usage:
//   bun run build.ts
//
// Output: ~/.cache/kobo-estonian-dictionary/dicthtml-et.zip

import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderWord, walkWordPaths, type WordDetails } from './dictionary';

const CACHE_DIR = `${homedir()}/.cache/kobo-estonian-dictionary`;
const WORDS_DIR = `${CACHE_DIR}/ekilex/words`;
const DF_FILE = `${CACHE_DIR}/estonian.df`;
const ZIP_FILE = `${CACHE_DIR}/dicthtml-et.zip`;
const LICENSE_SOURCE = join(import.meta.dir, 'dictionary-license.txt');
const LICENSE_STAGED = `${CACHE_DIR}/LICENSE`;

function renderEntry(data: WordDetails): string | null {
  const r = renderWord(data);
  if (!r) return null;
  const lines: string[] = [`@ ${r.headword}`];
  for (const v of r.variants) lines.push(`& ${v}`);
  lines.push(r.body);
  return lines.join('\n') + '\n\n';
}

async function buildDictfile(): Promise<void> {
  // Bun.file().writer() doesn't truncate, so an existing file's tail can
  // survive if the new content is shorter. Explicitly empty it first.
  await Bun.write(DF_FILE, '');
  const writer = Bun.file(DF_FILE).writer();

  let processed = 0;
  let written = 0;
  let skippedLang = 0;
  let skippedEmpty = 0;
  let errors = 0;
  const start = Date.now();

  for await (const path of walkWordPaths(WORDS_DIR)) {
    processed++;
    try {
      const data = (await Bun.file(path).json()) as WordDetails;
      if (data.word?.lang !== 'est') {
        skippedLang++;
        continue;
      }
      const entry = renderEntry(data);
      if (entry) {
        writer.write(entry);
        written++;
      } else {
        skippedEmpty++;
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`error on ${path}:`, e);
    }
    if (processed % 10000 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.log(
        `[${processed.toLocaleString()}] written=${written} ` +
          `skipLang=${skippedLang} skipEmpty=${skippedEmpty} ` +
          `errors=${errors} · ${(processed / elapsed).toFixed(0)}/s`,
      );
    }
  }

  await writer.end();
  console.log(
    `Dictfile done. processed=${processed} written=${written} ` +
      `skipLang=${skippedLang} skipEmpty=${skippedEmpty} errors=${errors}`,
  );
  console.log(`Wrote ${DF_FILE}`);
}

async function runDictgen(): Promise<void> {
  console.log(`Running dictgen -> ${ZIP_FILE}`);
  const result = await Bun.$`dictgen -o ${ZIP_FILE} ${DF_FILE}`.nothrow();
  if (result.exitCode !== 0) {
    console.error(
      'dictgen failed. Is it installed and on PATH? ' +
        'Get it from https://github.com/pgaskin/dictutil/releases',
    );
    process.exit(1);
  }
}

async function bundleLicense(): Promise<void> {
  // Stage under the name "LICENSE" so that's what shows up inside the zip;
  // `zip -j` takes the entry name from the file on disk.
  await Bun.write(LICENSE_STAGED, Bun.file(LICENSE_SOURCE));
  const result = await Bun.$`zip -j ${ZIP_FILE} ${LICENSE_STAGED}`.nothrow();
  await unlink(LICENSE_STAGED);
  if (result.exitCode !== 0) {
    console.error('zip failed when bundling LICENSE');
    process.exit(1);
  }
  console.log(`Bundled LICENSE into ${ZIP_FILE}`);
}

async function main() {
  await buildDictfile();
  await runDictgen();
  await bundleLicense();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
