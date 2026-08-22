import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const ALLOWED_DOMAINS = [
  'i0.hdslb.com',
  'i1.hdslb.com',
  'i2.hdslb.com',
  'hdslb.com'
];

export const GET: RequestHandler = async ({ params, setHeaders }) => {
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

    if (!isAllowed) {
      throw error(403, 'Domain not allowed');
    }
  } catch (err) {
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
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw error(response.status, `Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const cacheControl = response.headers.get('cache-control') || 'public, max-age=31536000';

    setHeaders({
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': '*'
    });

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl
      }
    });
  } catch (err) {
    console.error('Image proxy error:', err);
    throw error(500, 'Failed to fetch image');
  }
};
