import type { PageServerLoad } from './$types';
import { listStreamerSummaries } from '$lib/server/store';

export const load: PageServerLoad = () => ({ streamers: listStreamerSummaries(), generatedAt: new Date().toISOString() });

