#!/usr/bin/env bun
// Build a StarDict dictionary from scraped Ekilex data, for readers that speak
// StarDict (KOReader, sdcv, GoldenDict).
//
// A StarDict dictionary is a set of files sharing one base name:
//   <base>.ifo   - metadata (UTF-8 text)
//   <base>.idx   - headword index: for each entry "word\0" + u32 offset + u32 size
//   <base>.dict  - all definition bodies concatenated (sametypesequence=h: HTML)
//   <base>.syn   - synonyms: for each "form\0" + u32 index into the sorted idx
//
// idx and syn must be sorted with StarDict's comparison (ASCII-case-insensitive,
// strcmp tie-break) so the reader's binary search works. Headwords that collide
// (homonyms with distinct wordIds) are merged into one entry.
//
// Usage:
//   bun run build-stardict.ts
//
// Output: ~/.cache/kobo-estonian-dictionary/stardict-et.zip

import { mkdir, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderWord, walkWordPaths, type WordDetails } from './dictionary';

const CACHE_DIR = `${homedir()}/.cache/kobo-estonian-dictionary`;
const WORDS_DIR = `${CACHE_DIR}/ekilex/words`;
const BASE = 'eki-et';
const STAGE_DIR = `${CACHE_DIR}/stardict`;
const DICT_DIR = `${STAGE_DIR}/${BASE}`;
const ZIP_FILE = `${CACHE_DIR}/stardict-et.zip`;
const LICENSE_SOURCE = join(import.meta.dir, 'dictionary-license.txt');

const BOOKNAME = 'Eesti keele sõnaraamat (EKI)';

const enc = new TextEncoder();

// StarDict requires the idx/syn files sorted by stardict_strcmp: compare bytes
// ASCII-case-insensitively, and on a tie fall back to a plain byte strcmp. We
// compare on UTF-8 bytes, matching glib's g_ascii_strcasecmp semantics.
function asciiLower(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}
function stardictCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = asciiLower(a[i]!) - asciiLower(b[i]!);
    if (d !== 0) return d;
  }
  if (a.length !== b.length) return a.length - b.length;
  // Case-folded equal but possibly different bytes: stable strcmp tie-break.
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

interface Collected {
  // headword -> merged definition bodies (one per homonym sense group)
  bodies: Map<string, string[]>;
  // form -> set of headwords it inflects from / points to
  variants: Map<string, Set<string>>;
}

async function collect(): Promise<Collected> {
  const bodies = new Map<string, string[]>();
  const variants = new Map<string, Set<string>>();

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
      const r = renderWord(data);
      if (!r) {
        skippedEmpty++;
        continue;
      }
      // Drop the leading <html> marker (a Kobo dictgen convention); StarDict
      // renders the body as an HTML fragment.
      const body = r.body.replace(/^<html>/, '');
      const list = bodies.get(r.headword);
      if (list) list.push(body);
      else bodies.set(r.headword, [body]);

      for (const v of r.variants) {
        const set = variants.get(v);
        if (set) set.add(r.headword);
        else variants.set(v, new Set([r.headword]));
      }
      written++;
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

  console.log(
    `Collected. processed=${processed} headwords=${bodies.size} ` +
      `skipLang=${skippedLang} skipEmpty=${skippedEmpty} errors=${errors}`,
  );
  return { bodies, variants };
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

async function writeFiles({ bodies, variants }: Collected): Promise<void> {
  await rm(STAGE_DIR, { recursive: true, force: true });
  await mkdir(DICT_DIR, { recursive: true });

  // Sort headwords once; their position in this array is the index that .syn
  // entries reference.
  const headwords = [...bodies.keys()].sort((a, b) =>
    stardictCompare(enc.encode(a), enc.encode(b)),
  );
  const headIndex = new Map<string, number>();
  headwords.forEach((h, i) => headIndex.set(h, i));

  // .dict (streamed) + .idx (kept in memory; ~tens of bytes per entry).
  const dictSink = Bun.file(`${DICT_DIR}/${BASE}.dict`).writer();
  const idxChunks: Uint8Array[] = [];
  let offset = 0;
  for (const head of headwords) {
    const body = bodies.get(head)!.join('<hr/>');
    const bodyBytes = enc.encode(body);
    dictSink.write(bodyBytes);

    const word = enc.encode(head);
    idxChunks.push(word, new Uint8Array([0]), u32be(offset), u32be(bodyBytes.length));
    offset += bodyBytes.length;
  }
  await dictSink.end();
  const idxBuf = Buffer.concat(idxChunks);
  await Bun.write(`${DICT_DIR}/${BASE}.idx`, idxBuf);

  // .syn: a form may inflect from several headwords -> one entry each. Sort by
  // form so the reader can binary-search it too.
  const synEntries: Array<{ key: Uint8Array; index: number }> = [];
  for (const [form, heads] of variants) {
    for (const head of heads) {
      if (form === head) continue; // already directly indexed
      const index = headIndex.get(head);
      if (index === undefined) continue;
      synEntries.push({ key: enc.encode(form), index });
    }
  }
  synEntries.sort((a, b) => stardictCompare(a.key, b.key));
  const synChunks: Uint8Array[] = [];
  for (const { key, index } of synEntries) {
    synChunks.push(key, new Uint8Array([0]), u32be(index));
  }
  await Bun.write(`${DICT_DIR}/${BASE}.syn`, Buffer.concat(synChunks));

  // .ifo: idxfilesize must equal the byte length of the .idx file exactly.
  const date = new Date().toISOString().slice(0, 10);
  const ifo =
    `StarDict's dict ifo file\n` +
    `version=2.4.2\n` +
    `bookname=${BOOKNAME}\n` +
    `wordcount=${headwords.length}\n` +
    `synwordcount=${synEntries.length}\n` +
    `idxfilesize=${idxBuf.length}\n` +
    `sametypesequence=h\n` +
    `description=Built from the Ekilex 'eki' dataset. See LICENSE.\n` +
    `date=${date}\n`;
  await Bun.write(`${DICT_DIR}/${BASE}.ifo`, ifo);

  // Ship the attribution/license alongside the dictionary files.
  await Bun.write(`${DICT_DIR}/LICENSE`, Bun.file(LICENSE_SOURCE));

  console.log(
    `Wrote ${BASE}.{ifo,idx,dict,syn} to ${DICT_DIR} ` +
      `(words=${headwords.length} syn=${synEntries.length} ` +
      `dict=${(offset / 1e6).toFixed(1)}MB)`,
  );
}

async function bundleZip(): Promise<void> {
  // Zip the folder (not just the files) so it extracts to koreader/data/dict/
  // <BASE>/ in one step. `zip -r` records paths relative to its cwd.
  await unlink(ZIP_FILE).catch(() => {});
  const result = await Bun.$`zip -r ${ZIP_FILE} ${BASE}`.cwd(STAGE_DIR).nothrow();
  if (result.exitCode !== 0) {
    console.error('zip failed when bundling the StarDict files');
    process.exit(1);
  }
  console.log(`Wrote ${ZIP_FILE}`);
}

async function main() {
  const collected = await collect();
  await writeFiles(collected);
  await bundleZip();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
