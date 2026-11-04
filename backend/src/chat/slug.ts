/**
 * URL slugs for chats: "Slavic Winter Myths!" → "slavic-winter-myths".
 * "new" is reserved by the frontend for the unsent-draft route.
 */

const RESERVED = new Set(['new']);

// Cyrillic → Latin, plus Latin letters that accent-stripping can't decompose,
// so non-English titles still give readable slugs.
const TRANSLIT: Record<string, string> = {
  ł: 'l', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th', ð: 'd', ı: 'i',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g', ў: 'u', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', ђ: 'dj', џ: 'dz',
};

export function slugifyTitle(title: string): string {
  const slug = [...title.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!slug) return 'chat';
  return RESERVED.has(slug) ? `${slug}-chat` : slug;
}
