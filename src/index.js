import { Trace } from './trace.js';
import { definitions } from './tools.js';

export default {
  id: 'opencode-trace',
  async setup(ctx) {
    const trace = new Trace(ctx, ctx.options ?? {});
    const disposables = [], abort = new AbortController();
    const register = async (name, fn) => {
      try { disposables.push(await fn()); }
      catch (error) { trace.warning(`register ${name}`, error); }
    };
    await register('prompt', () => ctx.session.hook('prompt', e => trace.safe('prompt', () => trace.prompt(e))));
    await register('context', () => ctx.session.hook('context', async e => {
      const text = await trace.safe('context', () => trace.context(e));
      if (text && Array.isArray(e.system)) e.system.push({ type: 'text', text });
    }));
    await register('before', () => ctx.tool.hook('execute.before', e => trace.safe('before', () => trace.before(e))));
    await register('after', () => ctx.tool.hook('execute.after', e => trace.safe('after', () => trace.after(e))));
    await register('agents', () => ctx.agent.transform(editor => trace.safe('agents', async () => {
      const agents = editor.list().map(a => ({ id: a.id, name: a.name, description: a.description, mode: a.mode }));
      await trace.store.record('agents.snapshot', {}, agents);
    })));
    await register('tools', () => ctx.tool.transform(editor => { for (const definition of definitions(trace)) editor.add(definition); }));
    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type?.startsWith('session.')) await trace.safe('lifecycle', () => trace.lifecycle(event));
        }
      } catch (error) { if (!abort.signal.aborted) trace.warning('subscription', error); }
    })();
    return async () => {
      abort.abort(); trace.store.close();
      for (const d of disposables.reverse()) {
        try { if (typeof d === 'function') await d(); else await d?.dispose?.(); }
        catch (error) { trace.warning('dispose', error); }
      }
      // Host subscriptions cancel on abort; do not await a host iterator indefinitely.
      void subscription;
    };
  }
};
