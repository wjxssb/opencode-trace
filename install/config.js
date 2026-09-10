import { stable } from '../src/util.js';
// Small JSONC parser with source spans. Only edited properties lose whitespace;
// unrelated bytes, comments, strings and trailing commas stay untouched.
export function parseConfig(text) {
  const tokens = [];
  const re = /\s+|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/gy;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at; const match = re.exec(text);
    if (!match) throw new Error(`Invalid JSONC at byte/character ${at}`);
    const raw = match[0];
    if (!/^\s|^\/\//.test(raw) && !raw.startsWith('/*')) tokens.push({ raw, start: at, end: re.lastIndex });
    at = re.lastIndex;
  }
  let pos = 0;
  const take = raw => { const t = tokens[pos++]; if (!t || (raw && t.raw !== raw)) throw new Error('Invalid JSONC structure'); return t; };
  const parse = () => {
    const first = take(), node = { start: first.start };
    if (first.raw === '{') {
      node.value = {}; node.properties = [];
      while (tokens[pos]?.raw !== '}') {
        const key = take(); if (!key.raw.startsWith('"')) throw new Error('Expected property');
        const name = JSON.parse(key.raw); if (Object.hasOwn(node.value, name)) throw new Error('Duplicate config property');
        take(':'); const value = parse();
        const property = { name, start: key.start, end: value.end, node: value };
        node.properties.push(property);
        Object.defineProperty(node.value, name, { value: value.value, enumerable: true, configurable: true, writable: true });
        if (tokens[pos]?.raw !== ',') break;
        property.comma = take(',');
      }
      node.close = take('}'); node.end = node.close.end;
    } else if (first.raw === '[') {
      node.value = []; node.items = [];
      while (tokens[pos]?.raw !== ']') {
        const item = parse(); node.items.push(item); node.value.push(item.value);
        if (tokens[pos]?.raw !== ',') break;
        item.comma = take(',');
      }
      node.close = take(']'); node.end = node.close.end;
    } else { node.value = JSON.parse(first.raw); node.end = first.end; }
    return node;
  };
  const root = parse();
  if (pos !== tokens.length || !root.properties) throw new Error('Config must be a JSON object');
  return root;
}

export function addEntry(text, entry) {
  const root = parseConfig(text), property = root.properties.find(p => p.name === 'plugins');
  const serialized = JSON.stringify(entry);
  if (property) {
    const array = property.node; if (!array.items) throw new Error('plugins must be an array');
    if (array.items.some(i => i.value?.options?._opencodeTraceInstaller === 'opencode-trace-v1')) throw new Error('Trace already installed; rollback first');
    const last = array.items.at(-1), insert = `${last && !last.comma ? ',' : ''}\n    ${serialized}\n  `;
    return text.slice(0, array.close.start) + insert + text.slice(array.close.start);
  }
  const last = root.properties.at(-1);
  return text.slice(0, root.close.start) + `${last && !last.comma ? ',' : ''}\n  "plugins": [${serialized}]\n` + text.slice(root.close.start);
}

function cutItem(text, list, index) {
  const item = list[index], previous = list[index - 1];
  if (item.comma) return text.slice(0, item.start) + text.slice(item.comma.end);
  if (previous?.comma) return text.slice(0, previous.comma.start) + text.slice(previous.comma.end, item.start) + text.slice(item.end);
  return text.slice(0, item.start) + text.slice(item.end);
}

export function removeEntry(text, entry, originalHadPlugins) {
  const root = parseConfig(text), property = root.properties.find(p => p.name === 'plugins');
  if (!property) return text;
  const items = property.node.items; if (!items) throw new Error('plugins changed type; refusing unrelated edit');
  const matches = items.map((item, i) => item.value?.package === entry.package && item.value?.options?._opencodeTraceInstaller === entry.options._opencodeTraceInstaller ? i : -1).filter(i => i >= 0);
  if (!matches.length) return text;
  if (matches.length !== 1) throw new Error('Duplicate managed entry; refusing ambiguous edit');
  const i = matches[0];
  if (stable(items[i].value) !== stable(entry)) throw new Error('Managed entry changed; preserve it for review');
  if (items.length === 1 && !originalHadPlugins) return cutItem(text, root.properties, root.properties.indexOf(property));
  return cutItem(text, items, i);
}
