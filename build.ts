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

import { readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = `${homedir()}/.cache/kobo-estonian-dictionary`;
const WORDS_DIR = `${CACHE_DIR}/ekilex/words`;
const DF_FILE = `${CACHE_DIR}/estonian.df`;
const ZIP_FILE = `${CACHE_DIR}/dicthtml-et.zip`;
const LICENSE_SOURCE = join(import.meta.dir, 'dictionary-license.txt');
const LICENSE_STAGED = `${CACHE_DIR}/LICENSE`;

interface Form {
  value?: string;
}
interface Paradigm {
  forms?: Form[];
}
interface POS {
  value?: string;
}
interface Definition {
  value?: string;
  wwUnif?: boolean;
}
interface Usage {
  value?: string;
  wwUnif?: boolean;
}
interface Lexeme {
  pos?: POS[];
  meaning?: { definitions?: Definition[] };
  usages?: Usage[];
  wwUnif?: boolean;
}
interface Word {
  wordId: number;
  wordValue: string;
  lang: string;
  paradigms?: Paradigm[];
}
interface WordDetails {
  word: Word;
  lexemes?: Lexeme[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeHeadword(s: string): string {
  // Dictgen forbids quotes in headwords; collapse whitespace.
  return s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

function collectVariants(word: Word, headword: string): string[] {
  const set = new Set<string>();
  const headLower = headword.toLowerCase();
  for (const p of word.paradigms ?? []) {
    for (const f of p.forms ?? []) {
      const v = f.value?.trim().toLowerCase();
      if (!v || v === '-' || v === headLower) continue;
      // Variants can't contain newlines and shouldn't have markup; the
      // /word/details `value` field is plain (markup lives in valuePrese).
      if (/[\r\n]/.test(v)) continue;
      set.add(v);
    }
  }
  return [...set].sort();
}

function renderBody(lexemes: Lexeme[]): string {
  // Lexemes are senses of the same headword; render one numbered <li> per
  // sense. POS often only lives on the first lexeme; dedupe across all of
  // them.
  //
  // Filter on wwUnif === true at every level (lexeme, definition, usage) to
  // match the standard Sõnaveeb view. wwLite-only content is the simplified
  // learner view and shouldn't show up in a general dictionary.
  //
  // A single sense can carry multiple definition entries; join them with "; "
  // into one line. Usages attach as a nested <ul> under the combined
  // definition.
  const posSet = new Set<string>();
  const senses: Array<{ definition: string; examples: string[] }> = [];
  for (const lx of lexemes) {
    if (lx.wwUnif !== true) continue;
    for (const p of lx.pos ?? []) {
      const v = p.value?.trim();
      if (v) posSet.add(v);
    }
    const defs = (lx.meaning?.definitions ?? [])
      .filter((d) => d.wwUnif === true)
      .map((d) => d.value?.trim())
      .filter((v): v is string => !!v);
    if (defs.length === 0) continue;
    const examples = (lx.usages ?? [])
      .filter((u) => u.wwUnif === true)
      .map((u) => u.value?.trim())
      .filter((v): v is string => !!v);
    senses.push({ definition: defs.join('; '), examples });
  }
  if (senses.length === 0) return '';

  const parts: string[] = ['<html>'];
  if (posSet.size > 0) {
    parts.push(`<p><i>${escapeHtml([...posSet].join(', '))}</i></p>`);
  }
  parts.push('<ol>');
  for (const sense of senses) {
    parts.push('<li>');
    parts.push(escapeHtml(sense.definition));
    if (sense.examples.length > 0) {
      parts.push('<ul>');
      for (const ex of sense.examples) {
        parts.push(`<li><i>${escapeHtml(ex)}</i></li>`);
      }
      parts.push('</ul>');
    }
    parts.push('</li>');
  }
  parts.push('</ol>');
  return parts.join('');
}

function renderEntry(data: WordDetails): string | null {
  if (data.word?.lang !== 'est') return null;
  const headword = sanitizeHeadword(data.word.wordValue ?? '');
  if (!headword) return null;
  const body = renderBody(data.lexemes ?? []);
  if (!body) return null;
  const variants = collectVariants(data.word, headword);

  const lines: string[] = [`@ ${headword}`];
  for (const v of variants) lines.push(`& ${v}`);
  lines.push(body);
  return lines.join('\n') + '\n\n';
}

async function buildDictfile(): Promise<void> {
  // Bun.file().writer() doesn't truncate, so an existing file's tail can
  // survive if the new content is shorter. Explicitly empty it first.
  await Bun.write(DF_FILE, '');
  const writer = Bun.file(DF_FILE).writer();
  const shards = (await readdir(WORDS_DIR)).sort();

  let processed = 0;
  let written = 0;
  let skippedLang = 0;
  let skippedEmpty = 0;
  let errors = 0;
  const start = Date.now();

  for (const shard of shards) {
    const files = await readdir(join(WORDS_DIR, shard));
    for (const fname of files) {
      processed++;
      const path = join(WORDS_DIR, shard, fname);
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
