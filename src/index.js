import { Trace, RECALL_CONTEXT_POLICY } from './trace.js';
import { definitions } from './tools.js';
import { usesRequestData, usesRuntimeContext } from './context-delivery.js';

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
      const requestData = usesRequestData(e, ctx.options);
      const runtime = usesRuntimeContext(e, ctx.options);
      if ((requestData || runtime) && Array.isArray(e.system)) e.system.push({ type: 'text', text: RECALL_CONTEXT_POLICY });
      const append = text => {
        if (requestData) e.contextData.push({ source: 'opencode-trace', text });
        else e.system.push({ type: 'text', text });
      };
      const out = await trace.safe('context', () => trace.context(e));
      if (out?.recall && Array.isArray(e.system)) {
        if (runtime) e.runtimeContext.entries.push({
          source: 'opencode-trace', kind: 'retrieved', value: { status: 'available', snapshot: out.snapshot },
        });
        else append(out.recall);
        // Receipt of hook application, not proof of wire delivery or model use.
        // The legacy receipt retains the same snapshot's original rendering.
        await trace.safe('context.applied', () => trace.markContextApplied(e, out));
      } else if (Array.isArray(e.system)) {
        if (runtime) e.runtimeContext.entries.push({
          source: 'opencode-trace', kind: 'retrieved', value: {
            status: 'unavailable', reason: 'observer-budget-or-error',
            retrieve: ['native conversation records', 'trace_status', 'trace_find'],
          },
        });
        else append('OPENCODE_TRACE_RECALL_UNAVAILABLE: Trace could not prepare recall for this request within its observer budget. Historical evidence may be missing from this prompt; this does not mean there is no history or that prior work is resolved. Use native conversation records and trace_status/trace_find as needed. Native execution continues.');
      }
    }));
    await register('before', () => ctx.tool.hook('execute.before', e => trace.safe('before', () => trace.before(e))));
    await register('after', () => ctx.tool.hook('execute.after', e => trace.safe('after', () => trace.after(e))));
    await register('agents', () => ctx.agent.transform(editor => trace.safe('agents', async () => {
      const agents = editor.list().map(a => ({ id: a.id, name: a.name, description: a.description, mode: a.mode, model: a.model }));
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
