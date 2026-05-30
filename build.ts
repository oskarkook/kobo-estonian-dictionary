#!/usr/bin/env bun
// Build the Kobo dictionary zip from scraped Ekilex data.
//
// Steps:
//   1. Walk every saved /word/details JSON under <cache>/ekilex/words, filter
//      to Estonian (lang:"est"), and emit a single dictgen .df file with one
//      entry per word.
//   2. Run dictgen to produce <cache>/dicthtml-et.zip.
//   3. Render the LICENSE (CC BY 4.0 attribution + modifications description)
//      and bundle it into the zip.
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
const LICENSE_FILE = `${CACHE_DIR}/LICENSE`;

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

function renderLicense(): string {
  return `This dictionary is derived from the "EKI ühendsõnastik 2026" word
collection (sõnakogu), exported through Ekilex (https://ekilex.ee/), the
lexical database operated by Eesti Keele Instituut.

Citation
--------
EKI ühendsõnastik 2026. Eesti Keele Instituut, Ekilex 2026.
https://ekilex.ee

License
-------
The Ekilex content used to build this dictionary is licensed under the
Creative Commons Attribution 4.0 International License (CC BY 4.0).
- Human-readable summary: https://creativecommons.org/licenses/by/4.0/
- Full legal code:        https://creativecommons.org/licenses/by/4.0/legalcode

Modifications
-------------
This dictionary was produced from the "EKI ühendsõnastik 2026" sõnakogu
(dataset code: eki), exported via the Ekilex API, filtered/restructured for
usage in Kobo e-readers, and reformatted into HTML for Kobo dictionary format.

Endorsement
-----------
Eesti Keele Instituut does not endorse this derivative work.
`;
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
  const content = renderLicense();
  await Bun.write(LICENSE_FILE, content);
  // -j drops the directory prefix so the entry inside the zip is just
  // "LICENSE", not the full path.
  const result = await Bun.$`zip -j ${ZIP_FILE} ${LICENSE_FILE}`.nothrow();
  if (result.exitCode !== 0) {
    console.error('zip failed when bundling LICENSE');
    process.exit(1);
  }
  await unlink(LICENSE_FILE);
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
