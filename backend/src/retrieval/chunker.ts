/**
 * Splits text into retrieval chunks of up to ~MAX_CHARS characters
 * (~400 tokens): small enough that an excerpt is about one thing, large
 * enough to carry its own context.
 *
 * Markdown is split at headings first, then at paragraphs, then at sentence
 * ends. Each chunk after a heading keeps that heading as a prefix, so an
 * excerpt like "Costs are doubled at night" still says what it is about.
 */

const MAX_CHARS = 1600;
const MIN_CHARS = 200;

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > max && cur.trim()) {
      out.push(cur.trim());
      cur = '';
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Packs paragraphs into chunks, merging short ones. */
function pack(paragraphs: string[], max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of paragraphs.flatMap((p) => splitLong(p, max))) {
    if (cur && cur.length + p.length + 2 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  // Fold a short tail into the previous chunk.
  if (out.length > 1 && out[out.length - 1].length < MIN_CHARS) {
    const tail = out.pop()!;
    out[out.length - 1] += `\n\n${tail}`;
  }
  return out;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Chunks a plain message (no heading structure assumed). */
export function chunkText(text: string, max = MAX_CHARS): string[] {
  return pack(paragraphs(text), max);
}

/** Chunks a markdown document, keeping the current heading on each chunk. */
export function chunkMarkdown(text: string, max = MAX_CHARS): string[] {
  const sections: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      if (body.join('').trim()) sections.push({ heading, body: body.join('\n') });
      heading = m[1].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  if (body.join('').trim()) sections.push({ heading, body: body.join('\n') });

  const out: string[] = [];
  for (const s of sections) {
    const prefix = s.heading ? `${s.heading}\n` : '';
    for (const c of pack(paragraphs(s.body), max - prefix.length)) out.push(prefix + c);
  }
  return out;
}
