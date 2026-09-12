import { getSecret, getSetting } from './store';

export interface PiProfile {
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter';
  modelId: string;
  apiKeySecret?: string;
  baseUrl?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  input?: Array<'text' | 'image'>;
  output?: Array<'text'>;
  reasoning?: boolean;
  sessionAffinity?: boolean;
}

export const DEFAULT_PROFILE: PiProfile = {
  provider: 'openai',
  modelId: 'gpt-5.4-mini',
  apiKeySecret: 'pi_api_key',
  thinkingLevel: 'low',
  input: ['text', 'image'],
  output: ['text'],
  reasoning: true
};

export const piRuntime = { activeRuns: 0 };

export function getPiStatus(): { configured: boolean; profile: PiProfile; activeRuns: number } {
  const profile = getSetting<PiProfile>('pi_profile', DEFAULT_PROFILE);
  return { configured: Boolean(getSecret(profile.apiKeySecret ?? 'pi_api_key')), profile, activeRuns: piRuntime.activeRuns };
}
