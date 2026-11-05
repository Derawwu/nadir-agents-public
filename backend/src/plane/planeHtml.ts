/**
 * Plane stores descriptions and comments as HTML. Agents read and write
 * plain markdown-ish text, so these two helpers convert between the two.
 * They cover what Plane's editor produces for everyday writing (paragraphs,
 * headings, lists, line breaks, code); anything richer is flattened to text.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plane description HTML → plain text with markdown headings and bullets. */
export function planeHtmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    // Plane wraps list items in <p>; drop those so items stay one per line.
    .replace(/<li[^>]*>\s*<p[^>]*>/gi, '<li>')
    .replace(/<\/p>\s*<\/li>/gi, '</li>')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text / light markdown → Plane HTML (headings, bullets, paragraphs). */
export function textToPlaneHtml(text: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push(`<p>${para.map(escapeHtml).join('<br />')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((i) => `<li><p>${escapeHtml(i)}</p></li>`).join('')}</ul>`);
    list = [];
  };

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(`<h${heading[1]!.length}>${escapeHtml(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet) {
      flushPara();
      list.push(bullet[1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks.join('') || '<p></p>';
}
