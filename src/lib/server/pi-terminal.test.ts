import { describe, expect, it } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const model: Model<'anthropic-messages'> = {
  id: 'fixture', name: 'fixture', api: 'anthropic-messages', provider: 'anthropic',
  baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function exercise(count: number, failFirst = false, stopAfterSubmit = true) {
  let calls = 0; let submitted = false; const executed: number[] = [];
  const agent = new Agent({ initialState: { model, thinkingLevel: 'off', tools: [{
    name: 'submit', label: 'submit', description: 'submit', parameters: Type.Object({ count: Type.Number() }),
    execute: async (_id, params) => {
      if (failFirst && !executed.length && calls === 1) throw new Error('transaction failed');
      executed.push((params as { count: number }).count); submitted = true;
      return { content: [{ type: 'text', text: 'saved' }], details: null };
    }
  }] }, toolExecution: 'sequential', shouldStopAfterTurn: ({ toolResults }) => stopAfterSubmit && submitted && toolResults.every(t => !t.isError),
    streamFn: () => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const value = calls === 1 || (failFirst && !submitted)
        ? message([{ type: 'toolCall', id: `a-${calls}`, name: 'submit', arguments: { count } },
            { type: 'toolCall', id: `b-${calls}`, name: 'submit', arguments: { count } }], 'toolUse')
        : message([{ type: 'text', text: 'finished' }], 'stop');
      stream.push({ type: 'done', reason: value.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: value });
      return stream;
    }
  });
  await agent.prompt('submit');
  return { calls, executed, messages: agent.state.messages };
}
describe('Pi SDK terminal submission semantics', () => {
  it('finishes all tools in the current turn, not just the first one', async () => {
    const run = await exercise(2); expect(run.calls).toBe(1); expect(run.executed).toEqual([2, 2]);
    expect(run.messages.filter(m => m.role === 'toolResult')).toHaveLength(2);
  });
  it('an explicitly empty submission also finishes without another image request', async () => {
    const run = await exercise(0); expect(run.calls).toBe(1); expect(run.executed).toEqual([0, 0]);
  });
  it('failed submissions do not suppress the next repair turn', async () => {
    const run = await exercise(1, true); expect(run.calls).toBe(2); expect(run.executed).toEqual([1, 1]);
  });
  it('normal conversational agents still run their next turn', async () => {
    const run = await exercise(1, false, false); expect(run.calls).toBe(2);
  });
});
