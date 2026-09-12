import { afterEach, describe, expect, it } from 'vitest';
import { registerHybridPi } from './hybrid-pi';
const key = Symbol.for('vtbm.hybrid.pi.v1');
const registry = globalThis as unknown as Record<symbol, { run(input: unknown): Promise<void>; busy: boolean } | undefined>;
const previous = process.env.VTBM_HYBRID_CHILD;
afterEach(() => { delete registry[key]; if (previous === undefined) delete process.env.VTBM_HYBRID_CHILD; else process.env.VTBM_HYBRID_CHILD = previous; });
describe('hybrid TypeScript Pi bridge', () => {
  it('is not registered in a normal web or development process', () => {
    delete process.env.VTBM_HYBRID_CHILD; registerHybridPi(); expect(registry[key]).toBeUndefined();
  });
  it('rejects arbitrary operations before loading Pi', async () => {
    process.env.VTBM_HYBRID_CHILD = '1'; registerHybridPi();
    await expect(registry[key]!.run({ type: 'shell', entityId: 'x' })).rejects.toThrow('Unsupported');
    expect(registry[key]!.busy).toBe(false);
  });
  it('does not accept malformed job payloads', async () => {
    process.env.VTBM_HYBRID_CHILD = '1'; registerHybridPi();
    await expect(registry[key]!.run({ type: 'pi_analyze', entityId: 'x', payload: [] })).rejects.toThrow('Invalid Pi payload');
    expect(registry[key]!.busy).toBe(false);
  });
});
