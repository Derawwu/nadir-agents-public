/**
 * Stores pasted chat images as files on disk (data/uploads/), keeping the
 * SQLite messages table lightweight — only { filename, media_type } is persisted there.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? './data/uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface StoredImage {
  filename: string;
  media_type: string;
}

/**
 * Decodes a `data:<mime>;base64,<data>` URL and writes it to disk.
 * Throws if the media type isn't an allowed image type.
 */
export function saveImageFromDataUrl(dataUrl: string): StoredImage {
  const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid image data URL');

  const [, mediaType, base64Data] = match;
  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) throw new Error(`Unsupported image type: ${mediaType}`);

  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(base64Data, 'base64'));

  return { filename, media_type: mediaType };
}

export function readImageAsBase64(filename: string): string {
  return fs.readFileSync(path.join(UPLOADS_DIR, filename)).toString('base64');
}

export function getUploadsDir(): string {
  return UPLOADS_DIR;
}
