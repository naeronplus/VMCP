/**
 * Structural .tscn merge for host-side merge-apply (H-02).
 * Ports packages/orchestrator/src/services/tscn-merge.ts for Node on workers.
 */
export function parseTscn(content) {
  const raw = content.replace(/\r\n/g, '\n').split('\n');
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of raw) {
    if (line.startsWith('[')) {
      if (current) sections.push(current);
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

export function serializeTscn(ast) {
  const out = [...ast.preamble];
  for (const s of ast.sections) {
    out.push(s.header);
    out.push(...s.lines);
  }
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

function parseHeaderAttrs(header) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header))) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function nodePathFromHeader(header) {
  if (!header.startsWith('[node ')) return null;
  const attrs = parseHeaderAttrs(header);
  const name = attrs.name;
  if (!name) return null;
  const parent = attrs.parent;
  if (!parent || parent === '.') return name;
  return `${parent}/${name}`.replace(/^\.\//, '');
}

function setPropertyLines(lines, props) {
  const map = new Map();
  const order = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w/]*)\s*=\s*(.*)$/);
    if (m) {
      if (!map.has(m[1])) order.push(m[1]);
      map.set(m[1], m[2]);
    }
  }
  for (const [k, v] of Object.entries(props)) {
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    if (!map.has(k)) order.push(k);
    map.set(k, rendered);
  }
  const nonProps = lines.filter((l) => !/^[A-Za-z_][\w/]*\s*=/.test(l));
  const propLines = order.map((k) => `${k} = ${map.get(k)}`);
  return [...propLines, ...nonProps.filter((l) => l.trim() !== '')];
}

function normalizePatch(patch) {
  const nodes = [...(patch.nodes ?? [])];
  const ext = [...(patch.ext_resources ?? [])];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'nodes' || k === 'ext_resources') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      nodes.push({ path: k, properties: v });
    }
  }
  return { nodes, ext };
}

export function mergeTscn(base, patch) {
  const { nodes: nodePatches, ext: extPatches } = normalizePatch(patch);
  const sections = base.sections.map((s) => ({
    header: s.header,
    lines: [...s.lines],
  }));

  for (const ep of extPatches) {
    if (!ep.uid && !ep.id) continue;
    let found = false;
    for (const s of sections) {
      if (!s.header.startsWith('[ext_resource ')) continue;
      const attrs = parseHeaderAttrs(s.header);
      if ((ep.uid && attrs.uid === ep.uid) || (ep.id && attrs.id === ep.id)) {
        found = true;
        const next = { ...attrs };
        if (ep.type) next.type = ep.type;
        if (ep.path) next.path = ep.path;
        if (ep.uid) next.uid = ep.uid;
        if (ep.id) next.id = ep.id;
        s.header =
          '[ext_resource ' +
          Object.entries(next)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ') +
          ']';
      }
    }
    if (!found && ep.type && ep.path) {
      const id = ep.id ?? `ext_${sections.length}`;
      const parts = [`type="${ep.type}"`, `path="${ep.path}"`];
      if (ep.uid) parts.push(`uid="${ep.uid}"`);
      parts.push(`id="${id}"`);
      sections.push({ header: `[ext_resource ${parts.join(' ')}]`, lines: [] });
    }
  }

  for (const np of nodePatches) {
    const path =
      np.path ??
      (np.parent && np.name
        ? np.parent === '.'
          ? np.name
          : `${np.parent}/${np.name}`
        : np.name);
    if (!path) continue;

    if (np.delete) {
      const idx = sections.findIndex(
        (s) => s.header.startsWith('[node ') && nodePathFromHeader(s.header) === path,
      );
      if (idx >= 0) sections.splice(idx, 1);
      continue;
    }

    const idx = sections.findIndex(
      (s) => s.header.startsWith('[node ') && nodePathFromHeader(s.header) === path,
    );
    if (idx >= 0) {
      if (np.properties) {
        sections[idx].lines = setPropertyLines(sections[idx].lines, np.properties);
      }
      continue;
    }

    const name = np.name ?? path.split('/').pop();
    const parent =
      np.parent ?? (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
    const type = np.type ?? 'Node';
    const header = `[node name="${name}" type="${type}" parent="${parent}"]`;
    const lines = np.properties ? setPropertyLines([], np.properties) : [];
    sections.push({ header, lines });
  }

  return { preamble: [...base.preamble], sections };
}

export function applyTscnPatch(baseContent, patch) {
  return serializeTscn(mergeTscn(parseTscn(baseContent), patch));
}
