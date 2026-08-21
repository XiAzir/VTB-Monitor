import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { resolveMediaFile } from '$lib/server/media';

export const GET = async ({ params }) => {
  const file = await resolveMediaFile(params.id);
  if (!file) error(404, '图片不存在');
  return new Response(Readable.toWeb(file.stream) as ReadableStream, {
    headers: {
      'content-type': file.mime,
      'content-length': String(file.size),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    }
  });
};

