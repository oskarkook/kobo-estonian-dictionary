#!/usr/bin/env bun
// Build the Kobo dictionary zip from scraped Ekilex data.
//
// Steps:
//   1. Walk every saved /word/details JSON under data/ekilex/words, filter to
//      Estonian (lang:"est"), and emit a single dictgen .df file with one
//      entry per word. Collect author names from edit metadata in the same
//      pass.
//   2. Run dictgen to produce data/dicthtml-et.zip.
//   3. Render the LICENSE (CC BY 4.0 attribution + derived authors list +
//      modifications description) and bundle it into the zip.
//
// Usage:
//   bun run build.ts
//
// Output: data/dicthtml-et.zip

import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const WORDS_DIR = 'data/ekilex/words';
const DF_FILE = 'data/estonian.df';
const ZIP_FILE = 'data/dicthtml-et.zip';
const LICENSE_FILE = 'data/LICENSE';

// Non-human accounts that appear in createdBy/modifiedBy and should not be
// listed as authors. Checked after paren-stripping. Loader bots use the
// pattern "Ekilex <code>-laadur"; a generic "Laadur" account has by far the
// most edits in the dataset.
const BOT_NAMES = new Set(['Laadur', 'Kollide kolija']);
function isBotAccount(name: string): boolean {
  return BOT_NAMES.has(name) || /^Ekilex /.test(name);
}

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
  // Lexemes are senses of the same headword; render their definitions as a
  // single continuous numbered list so the count doesn't restart per sense.
  // POS often only lives on the first lexeme; dedupe across all of them.
  //
  // Filter on wwUnif === true at every level (lexeme, definition, usage) to
  // match the standard Sõnaveeb view. wwLite-only content is the simplified
  // learner view and shouldn't show up in a general dictionary.
  //
  // Examples (usages) are per-lexeme; we attach them as a nested <ul> under
  // the last definition of each sense to keep them grouped correctly.
  const posSet = new Set<string>();
  const senses: Array<{ defs: string[]; examples: string[] }> = [];
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
    senses.push({ defs, examples });
  }
  if (senses.length === 0) return '';

  const parts: string[] = ['<html>'];
  if (posSet.size > 0) {
    parts.push(`<p><i>${escapeHtml([...posSet].join(', '))}</i></p>`);
  }
  parts.push('<ol>');
  for (const sense of senses) {
    const lastIdx = sense.defs.length - 1;
    for (let i = 0; i < sense.defs.length; i++) {
      parts.push('<li>');
      parts.push(escapeHtml(sense.defs[i]!));
      if (i === lastIdx && sense.examples.length > 0) {
        parts.push('<ul>');
        for (const ex of sense.examples) {
          parts.push(`<li><i>${escapeHtml(ex)}</i></li>`);
        }
        parts.push('</ul>');
      }
      parts.push('</li>');
    }
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

// Recursively collect every createdBy / modifiedBy string in a parsed JSON
// tree. Names live on definitions, usages, freeforms, notes, and possibly
// other nested objects; walking generically avoids missing any field.
function collectAuthorsFrom(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectAuthorsFrom(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'createdBy' || key === 'modifiedBy') && typeof value === 'string') {
      const cleaned = value.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned && !isBotAccount(cleaned)) out.add(cleaned);
    } else {
      collectAuthorsFrom(value, out);
    }
  }
}

function formatAuthorsList(names: Set<string>): string {
  // EKI's citation convention is "Surname, Firstname" with entries joined by
  // semicolons. Treat the last whitespace-separated token as the surname.
  const formatted = [...names]
    .map((name) => {
      const parts = name.split(/\s+/);
      if (parts.length < 2) return { surname: name, formatted: name };
      const surname = parts[parts.length - 1]!;
      const given = parts.slice(0, -1).join(' ');
      return { surname, formatted: `${surname}, ${given}` };
    })
    .sort((a, b) => a.surname.localeCompare(b.surname, 'et'));
  return formatted.map((f) => f.formatted).join('; ');
}

function renderLicense(authors: Set<string>): string {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  const buildDate = `${dd}.${mm}.${yyyy}`;
  const authorsList = formatAuthorsList(authors);

  return `This dictionary is derived from the "EKI ühendsõnastik 2026" word
collection (sõnakogu) in Ekilex (https://ekilex.ee/), the lexical database
operated by the Institute of the Estonian Language (Eesti Keele Instituut).

Citation
--------
EKI ühendsõnastik 2026. [The EKI Combined Dictionary, CombiDic]
Koostanud ja toimetanud ${authorsList}.
Eesti Keele Instituut. Sõnaveeb 2026. https://sonaveeb.ee (${buildDate})

The authors list above is derived from edit metadata in the data
extracted from Ekilex via its public API on the date shown. For the
canonical credits maintained by EKI, see
https://sonaveeb.ee/collections.

License
-------
The Ekilex content used to build this dictionary is licensed under the
Creative Commons Attribution 4.0 International License (CC BY 4.0).
- Human-readable summary: https://creativecommons.org/licenses/by/4.0/
- Full legal code:        https://creativecommons.org/licenses/by/4.0/legalcode

Modifications
-------------
This dictionary was produced from the "EKI ühendsõnastik 2026" sõnakogu
(dataset code: eki) via the Ekilex public API, filtered/restructured for usage
in Kobo e-readers, and reformatted into HTML for Kobo dictionary format.

Endorsement
-----------
The Institute of the Estonian Language does not endorse this derivative
work.
`;
}

async function buildDictfile(): Promise<Set<string>> {
  // Bun.file().writer() doesn't truncate, so an existing file's tail can
  // survive if the new content is shorter. Explicitly empty it first.
  await Bun.write(DF_FILE, '');
  const writer = Bun.file(DF_FILE).writer();
  const shards = (await readdir(WORDS_DIR)).sort();
  const authors = new Set<string>();

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
        collectAuthorsFrom(data, authors);
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
            `authors=${authors.size} errors=${errors} ` +
            `· ${(processed / elapsed).toFixed(0)}/s`,
        );
      }
    }
  }

  await writer.end();
  console.log(
    `Dictfile done. processed=${processed} written=${written} ` +
      `skipLang=${skippedLang} skipEmpty=${skippedEmpty} ` +
      `authors=${authors.size} errors=${errors}`,
  );
  console.log(`Wrote ${DF_FILE}`);
  return authors;
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

async function bundleLicense(authors: Set<string>): Promise<void> {
  const content = renderLicense(authors);
  await Bun.write(LICENSE_FILE, content);
  // -j drops the directory prefix so the entry inside the zip is just
  // "LICENSE", not "data/LICENSE".
  const result = await Bun.$`zip -j ${ZIP_FILE} ${LICENSE_FILE}`.nothrow();
  if (result.exitCode !== 0) {
    console.error('zip failed when bundling LICENSE');
    process.exit(1);
  }
  await unlink(LICENSE_FILE);
  console.log(`Bundled LICENSE (${authors.size} authors) into ${ZIP_FILE}`);
}

async function main() {
  const authors = await buildDictfile();
  await runDictgen();
  await bundleLicense(authors);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
