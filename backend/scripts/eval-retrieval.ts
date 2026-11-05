/**
 * Retrieval eval: how often does search find the passage that answers a question?
 *
 *   npx tsx scripts/eval-retrieval.ts --generate 60   # build both question sets (Haiku, < $0.01)
 *   npx tsx scripts/eval-retrieval.ts                 # score bm25 vs vector vs hybrid
 *
 * The set is built from the real index: chunks are sampled (up to a sixth
 * from diagrams when there are any, the rest split between chat messages and
 * wiki pages), and Claude writes one question per chunk that the
 * chunk answers, worded the way a teammate would ask it weeks later, not
 * copied from the text. A hit is any chunk from the same source (message or
 * wiki page) as the one the question was written from.
 *
 * Two sets are generated from the same chunks:
 *   - natural: worded freely. Questions written from a passage tend to reuse
 *     its words, which flatters keyword search.
 *   - paraphrased: must avoid the passage's distinctive words (names
 *     excepted), as when someone remembers the idea but not the wording.
 *     This is where embedding search should earn its keep.
 *
 * It also writes off-topic questions the corpus can't answer. Those measure
 * the other failure: retrieval stuffing irrelevant excerpts into the prompt.
 * The threshold sweep shows, for each RETRIEVAL_MIN_SIMILARITY, how many
 * answerable questions still get their passage vs. how many off-topic ones
 * get anything at all.
 *
 * The set is written to data/eval/ (gitignored): it quotes private chats.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import db from '../src/db/connection';
import { modelExtras, textOf } from '../src/llm/modelParams';
import { recordCall } from '../src/llm/usageLog';
import { embedQuery, searchChunks, selectForContext, type SearchHit, type SearchMode, type SourceType } from '../src/retrieval/search';
import { getEmbeddingModel } from '../src/retrieval/config';

type SetStyle = 'natural' | 'paraphrased';
const STYLES: SetStyle[] = ['natural', 'paraphrased'];
const setPath = (style: SetStyle) => path.join(__dirname, '..', 'data', 'eval', `retrieval-set-${style}.json`);

const STYLE_RULES: Record<SetStyle, string> = {
  natural: '- Word it naturally, as a person would type it into a chat. Do not copy phrases from the passage; names and game terms are fine.',
  paraphrased:
    "- Describe what you're asking about in different words: do not use the passage's distinctive words or game terms. Proper names (characters, places, gods) may stay. Imagine someone who remembers the idea but not how it was phrased.",
};
const GEN_MODEL = 'claude-haiku-5-5';
const BATCH = 10;

interface EvalItem {
  question: string;
  /** Null for off-topic questions. */
  sourceType: SourceType | null;
  sourceId: string | null;
  chunkId: number | null;
}

// ─── Generation ──────────────────────────────────────────────────────────────

/** Deterministic shuffle, so a regenerated set samples the same chunks. */
function seededShuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`No JSON array in: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

async function ask(anthropic: Anthropic, prompt: string): Promise<string> {
  const startedAt = Date.now();
  const res = await anthropic.messages.create({
    model: GEN_MODEL,
    max_tokens: 8000,
    ...(modelExtras(GEN_MODEL, 'low').body as object),
    messages: [{ role: 'user', content: prompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  recordCall({ kind: 'eval' }, res, { startedAt });
  return textOf(res);
}

async function generate(n: number, style: SetStyle): Promise<void> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const pick = (type: SourceType, count: number, minChars = 400) => {
    const rows = db
      .prepare(
        `SELECT id, source_type, source_id, text FROM retrieval_chunks
         WHERE source_type = ? AND length(text) >= ? ORDER BY id`
      )
      .all(type, minChars) as { id: number; source_type: SourceType; source_id: string; text: string }[];
    // One chunk per source, so no source dominates the set.
    const seen = new Set<string>();
    const unique = seededShuffle(rows).filter((r) => (seen.has(r.source_id) ? false : (seen.add(r.source_id), true)));
    return unique.slice(0, count);
  };
  // Diagram listings are terse, so they qualify from 200 characters.
  const diagrams = pick('diagram', Math.floor(n / 6), 200);
  const rest = n - diagrams.length;
  const chunks = [...pick('message', Math.ceil(rest / 2)), ...pick('wiki', Math.floor(rest / 2)), ...diagrams];

  const items: EvalItem[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const prompt = `Below are ${batch.length} passages from a game studio's design chats and wiki.

For each passage, write one question that a team member might ask weeks later, which this passage answers.
- Ask about the passage's specific content (a decision, number, rule, name or reason), not its general topic.
${STYLE_RULES[style]}
- The question must make sense on its own, without seeing the passage.

Reply with only a JSON array of ${batch.length} objects, one per passage: {"index": <passage index>, "question": "..."}.

${batch.map((c, j) => `<passage index="${j}">\n${c.text.slice(0, 2500)}\n</passage>`).join('\n\n')}`;
    // Paired by the index the model echoes back, not by array position: a
    // plain list silently shifts every later question if one is skipped.
    const answers = parseJsonArray(await ask(anthropic, prompt)) as { index?: number; question?: string }[];
    for (const a of answers) {
      const c = typeof a.index === 'number' ? batch[a.index] : undefined;
      if (c && typeof a.question === 'string' && !items.some((it) => it.chunkId === c.id))
        items.push({ question: a.question, sourceType: c.source_type, sourceId: c.source_id, chunkId: c.id });
    }
    console.log(`Generated ${items.length}/${chunks.length}`);
  }

  const offTopic = parseJsonArray(
    await ask(
      anthropic,
      `Write 20 short messages a user might send to an AI assistant in a game-development team chat app, which have nothing to do with any particular game's design: everyday chit-chat, general programming or tooling questions, cooking, travel, sports, general trivia. Vary length and tone. Reply with only a JSON array of strings.`
    )
  ) as string[];
  for (const q of offTopic) items.push({ question: q, sourceType: null, sourceId: null, chunkId: null });

  const out = setPath(style);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ style, createdAt: new Date().toISOString(), items }, null, 2));
  console.log(`Wrote ${items.length} ${style} items to ${out}`);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function rankOf(hits: SearchHit[], item: EvalItem): number | null {
  const i = hits.findIndex((h) => h.sourceType === item.sourceType && h.sourceId === item.sourceId);
  return i < 0 ? null : i;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

async function score(style: SetStyle): Promise<void> {
  const file = setPath(style);
  if (!fs.existsSync(file)) {
    console.error(`No eval set at ${file}. Run with --generate first.`);
    process.exit(1);
  }
  const { items } = JSON.parse(fs.readFileSync(file, 'utf8')) as { items: EvalItem[] };
  const positives = items.filter((i) => i.sourceId !== null);
  const negatives = items.filter((i) => i.sourceId === null);

  // Embed every question once; all modes reuse the vector.
  const t0 = Date.now();
  const vectors = new Map<string, Float32Array | null>();
  for (const it of items) vectors.set(it.question, await embedQuery(it.question, 60_000));
  const embedMs = (Date.now() - t0) / items.length;

  const modes: SearchMode[] = ['bm25', 'vector', 'hybrid'];
  const rows: string[] = [];
  const hybridHits = new Map<string, SearchHit[]>();
  for (const mode of modes) {
    let r1 = 0, r5 = 0, mrr = 0, ms = 0;
    const byType = { message: { n: 0, r5: 0 }, wiki: { n: 0, r5: 0 }, diagram: { n: 0, r5: 0 } };
    for (const it of positives) {
      const s = Date.now();
      const hits = await searchChunks(it.question, { mode, limit: 20, queryVector: vectors.get(it.question) ?? null });
      ms += Date.now() - s;
      if (mode === 'hybrid') hybridHits.set(it.question, hits);
      const rank = rankOf(hits.slice(0, 10), it);
      if (rank === 0) r1++;
      if (rank !== null && rank < 5) r5++;
      if (rank !== null) mrr += 1 / (rank + 1);
      const t = byType[it.sourceType!];
      t.n++;
      if (rank !== null && rank < 5) t.r5++;
    }
    const n = positives.length;
    rows.push(
      `| ${mode} | ${pct(r1 / n)} | ${pct(r5 / n)} | ${(mrr / n).toFixed(2)} | ${pct(byType.message.r5 / (byType.message.n || 1))} | ${pct(byType.wiki.r5 / (byType.wiki.n || 1))} | ${(ms / n).toFixed(0)} ms |`
    );
  }
  for (const it of negatives) {
    hybridHits.set(it.question, await searchChunks(it.question, { mode: 'hybrid', limit: 20, queryVector: vectors.get(it.question) ?? null }));
  }

  console.log(`\n## ${style} set\n\nRetrieval eval: ${positives.length} answerable questions (${positives.filter((p) => p.sourceType === 'message').length} chat, ${positives.filter((p) => p.sourceType === 'wiki').length} wiki, ${positives.filter((p) => p.sourceType === 'diagram').length} diagram), ${negatives.length} off-topic, embeddings ${getEmbeddingModel()}\n`);
  console.log('| Search | Recall@1 | Recall@5 | MRR@10 | Recall@5 chat | Recall@5 wiki | Search time |');
  console.log('|---|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log(`\nQuery embedding: ${embedMs.toFixed(0)} ms per question.`);

  // Threshold sweep on what would actually reach the prompt.
  console.log('\n| Min similarity | Answerable: passage reaches the prompt | Answerable: excerpts per prompt | Off-topic: prompts with any excerpt | Off-topic: excerpts per prompt |');
  console.log('|---|---|---|---|---|');
  for (let t = 0.4; t <= 0.701; t += 0.05) {
    let found = 0, posExcerpts = 0, negAny = 0, negExcerpts = 0;
    for (const it of positives) {
      const sel = selectForContext(hybridHits.get(it.question)!, t);
      posExcerpts += sel.length;
      if (rankOf(sel, it) !== null) found++;
    }
    for (const it of negatives) {
      const sel = selectForContext(hybridHits.get(it.question)!, t);
      negExcerpts += sel.length;
      if (sel.length > 0) negAny++;
    }
    console.log(
      `| ${t.toFixed(2)} | ${pct(found / positives.length)} | ${(posExcerpts / positives.length).toFixed(1)} | ${pct(negAny / (negatives.length || 1))} | ${(negExcerpts / (negatives.length || 1)).toFixed(1)} |`
    );
  }
}

async function main(): Promise<void> {
  const genIdx = process.argv.indexOf('--generate');
  for (const style of STYLES) {
    if (genIdx >= 0) await generate(parseInt(process.argv[genIdx + 1] ?? '60', 10) || 60, style);
    else await score(style);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
