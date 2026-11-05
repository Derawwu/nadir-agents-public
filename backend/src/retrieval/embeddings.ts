/**
 * Text embeddings from a local Ollama server.
 *
 * Embeddings run locally (default model qwen3-embedding:0.6b, 1024 dims):
 * free, offline, and chat history never leaves the machine. Claude doesn't
 * offer an embeddings endpoint, so this is the one model call that isn't
 * Anthropic's.
 *
 * Vectors are L2-normalized here, so cosine similarity is a dot product.
 */

import { getEmbeddingModel, getOllamaBaseUrl } from './config';

/**
 * Qwen3-Embedding is trained with an instruction on the query side only;
 * documents are embedded as-is.
 */
const QUERY_INSTRUCTION =
  'Instruct: Given a message in a game-design discussion, retrieve earlier messages and wiki passages that are relevant to it\nQuery:';

const BATCH_SIZE = 16;

export type EmbedKind = 'query' | 'document';

function normalize(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function embedBatch(input: string[], timeoutMs: number): Promise<Float32Array[]> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // keep_alive keeps the model loaded between messages; the first load takes ~10 s.
    body: JSON.stringify({ model: getEmbeddingModel(), input, keep_alive: '30m', truncate: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings.map(normalize);
}

export async function embed(
  texts: string[],
  kind: EmbedKind,
  opts: { timeoutMs?: number } = {}
): Promise<Float32Array[]> {
  const input = kind === 'query' ? texts.map((t) => `${QUERY_INSTRUCTION}${t}`) : texts;
  const out: Float32Array[] = [];
  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(input.slice(i, i + BATCH_SIZE), opts.timeoutMs ?? 120_000)));
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: SQLite's buffer may not be 4-byte aligned.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
