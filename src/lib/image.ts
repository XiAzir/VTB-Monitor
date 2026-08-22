/**
 * Proxies Bilibili image URLs through our server to bypass referer restrictions.
 * For images hosted on hdslb.com domains, returns a proxied URL.
 * For other images, returns the original URL.
 */
export function proxyBilibiliImage(url: string | null | undefined): string | null {
  if (!url) return null;

  // Normalize protocol-relative URLs
  let normalized = url;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }

  // Check if this is a Bilibili CDN image
  const isBilibiliImage = /^https?:\/\/.*\.hdslb\.com\//i.test(normalized);

  if (isBilibiliImage) {
    // Remove protocol and proxy through our server
    const pathPart = normalized.replace(/^https?:\/\//, '');
    return `/api/image-proxy/${pathPart}`;
  }

  return normalized;
}
