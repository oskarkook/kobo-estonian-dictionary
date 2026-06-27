// Shared parsing/rendering of scraped Ekilex /word/details JSON.
//
// Both build targets consume the same data and produce the same entry body:
//   - build.ts          -> Kobo dicthtml (.df + dictgen)
//   - build-stardict.ts -> StarDict (KOReader, sdcv, GoldenDict, ...)

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Form {
  value?: string;
}
export interface Paradigm {
  forms?: Form[];
}
export interface POS {
  value?: string;
}
export interface Definition {
  value?: string;
  wwUnif?: boolean;
}
export interface Usage {
  value?: string;
  wwUnif?: boolean;
}
export interface Lexeme {
  pos?: POS[];
  meaning?: { definitions?: Definition[] };
  usages?: Usage[];
  wwUnif?: boolean;
}
export interface Word {
  wordId: number;
  wordValue: string;
  lang: string;
  paradigms?: Paradigm[];
}
export interface WordDetails {
  word: Word;
  lexemes?: Lexeme[];
}

export interface RenderedWord {
  headword: string;
  variants: string[];
  /** HTML body, wrapped in a leading <html> marker (Kobo dictgen convention). */
  body: string;
}

export function escapeHtml(s: string): string {
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

/** Parse one /word/details payload into a renderable entry, or null to skip. */
export function renderWord(data: WordDetails): RenderedWord | null {
  if (data.word?.lang !== 'est') return null;
  const headword = sanitizeHeadword(data.word.wordValue ?? '');
  if (!headword) return null;
  const body = renderBody(data.lexemes ?? []);
  if (!body) return null;
  const variants = collectVariants(data.word, headword);
  return { headword, variants, body };
}

/** Yield every word JSON path under WORDS_DIR, shard by shard, sorted. */
export async function* walkWordPaths(wordsDir: string): AsyncGenerator<string> {
  const shards = (await readdir(wordsDir)).sort();
  for (const shard of shards) {
    const files = await readdir(join(wordsDir, shard));
    for (const fname of files) {
      yield join(wordsDir, shard, fname);
    }
  }
}
