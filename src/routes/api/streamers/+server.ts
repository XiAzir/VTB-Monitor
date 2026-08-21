import { json } from '@sveltejs/kit';
import { listStreamerSummaries } from '$lib/server/store';

export const GET = () => json({ data: listStreamerSummaries(), generatedAt: new Date().toISOString() }, {
  headers: { 'cache-control': 'public, max-age=15, stale-while-revalidate=30' }
});

