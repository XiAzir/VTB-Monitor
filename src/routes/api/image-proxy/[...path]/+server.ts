import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const ALLOWED_DOMAINS = [
  'i0.hdslb.com',
  'i1.hdslb.com',
  'i2.hdslb.com',
  'hdslb.com'
];
const MAX_PROXY_BYTES = 25 * 1024 * 1024;

export const GET: RequestHandler = async ({ params }) => {
  const path = params.path;

  if (!path) {
    throw error(400, 'Missing image path');
  }

  // Reconstruct the full URL
  let imageUrl = path;

  // Handle protocol-relative URLs
  if (imageUrl.startsWith('//')) {
    imageUrl = `https:${imageUrl}`;
  } else if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    imageUrl = `https://${imageUrl}`;
  }

  // Validate domain for security
  try {
    const url = new URL(imageUrl);
    const isAllowed = ALLOWED_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );

    if (!isAllowed) throw error(403, 'Domain not allowed');
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err) throw err;
    throw error(400, 'Invalid URL');
  }

  // Fetch the image with proper headers
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw error(response.status, `Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!contentType?.startsWith('image/')) throw error(502, 'Upstream did not return an image');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_PROXY_BYTES) throw error(413, 'Image is too large');
    const cacheControl = response.headers.get('cache-control') || 'public, max-age=31536000';

    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BYTES) throw error(413, 'Image is too large');
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': cacheControl
      }
    });
  } catch (err) {
    console.error('Image proxy error:', err);
    if (err && typeof err === 'object' && 'status' in err) throw err;
    throw error(500, 'Failed to fetch image');
  }
};
