#!/usr/bin/env node
// BetterTrack knowledge-pack generator.
//
// Deterministic, dependency-free (fs/path + regex only). Scans apps/*/src and
// packages/*/src for .ts/.tsx source and emits two artifacts consumed by the
// build factory to avoid cold-start re-reads:
//
//   factory/knowledge/graph.json  — machine-queryable module graph (jq-friendly)
//   factory/knowledge/MAP.md      — human-readable module map
//
// Both outputs are .gitignored; only this generator is committed. Idempotent,
// finishes in seconds. Requires Node >= 20 (ESM).

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, basename, posix } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..'); // factory/knowledge -> repo root
const OUT_GRAPH = join(__dirname, 'graph.json');
const OUT_MAP = join(__dirname, 'MAP.md');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.vite']);
const EXTS = ['.ts', '.tsx'];

// ---- discover workspace roots (apps/*, packages/*) ----------------------------
function workspaceRoots() {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    const gdir = join(REPO, group);
    if (!existsSync(gdir)) continue;
    for (const name of readdirSync(gdir)) {
      const root = join(gdir, name);
      if (!statSync(root).isDirectory()) continue;
      if (existsSync(join(root, 'src'))) roots.push(root);
    }
  }
  return roots;
}

// Map workspace package name (@bettertrack/foo) -> its src entry (repo-relative).
function packageIndexMap(roots) {
  const map = {};
  for (const root of roots) {
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(pkgPath, 'utf8')).name;
    } catch {
      continue;
    }
    if (!name) continue;
    for (const idx of ['src/index.ts', 'src/index.tsx']) {
      const full = join(root, idx);
      if (existsSync(full)) {
        map[name] = rel(full);
        break;
      }
    }
  }
  return map;
}

function rel(p) {
  return relative(REPO, p).split('\\').join('/'); // posix-style repo-relative
}

// ---- file discovery -----------------------------------------------------------
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
}

// ---- kind heuristic -----------------------------------------------------------
function classify(path, file, pkg) {
  const p = path.toLowerCase();
  const f = file.toLowerCase();
  if (p.includes('/__tests__/') || /\.(test|spec)\.tsx?$/.test(f)) return 'test';
  if (p.includes('/routes/') || /routes?\.tsx?$/.test(f)) return 'route';
  if (p.includes('/domain/')) return 'domain';
  if (p.includes('/jobs/')) return 'job';
  if (pkg === 'packages/contracts' || /schema\.tsx?$/.test(f) || f.includes('schema'))
    return 'schema';
  if (p.includes('/services/') || p.includes('/providers/')) return 'service';
  if (p.includes('/hooks/') || /^use[a-z0-9]/i.test(file)) return 'hook';
  if (p.includes('/pages/') || /page\.tsx$/.test(f)) return 'page';
  if (p.includes('/components/') || p.includes('/ui/') || file.endsWith('.tsx')) return 'component';
  if (p.includes('/config/') || /^(env|config)\.tsx?$/.test(f)) return 'config';
  return 'other';
}

// ---- export extraction (regex heuristic) --------------------------------------
function extractExports(src) {
  const names = new Set();
  // export [async] function|class|const|let|var|interface|type|enum|abstract class Foo
  const decl =
    /\bexport\s+(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = decl.exec(src))) names.add(m[1]);
  // export default ...
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  // export { a, b as c } [from '...']
  const list = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
  while ((m = list.exec(src))) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const as = part.match(/\bas\s+([A-Za-z0-9_$]+)/); // exported name is the alias
      const name = as ? as[1] : part.replace(/^type\s+/, '').trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return [...names];
}

// ---- import extraction --------------------------------------------------------
function extractSpecifiers(src) {
  const specs = new Set();
  // import ... from '...'  /  export ... from '...'
  const from = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = from.exec(src))) specs.add(m[1]);
  // side-effect import '...'
  const side = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = side.exec(src))) specs.add(m[1]);
  // dynamic import('...')
  const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) specs.add(m[1]);
  return [...specs];
}

// Resolve a specifier to a repo-relative source path, or null (external).
function resolveSpec(spec, fromPath, fileSet, pkgIndex) {
  if (spec.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    return tryCandidates(base, fileSet);
  }
  if (spec.startsWith('@bettertrack/')) {
    const pkgName = spec.split('/').slice(0, 2).join('/');
    return pkgIndex[pkgName] || null; // subpaths resolve to the package entry
  }
  return null;
}

function tryCandidates(base, fileSet) {
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of cands) if (fileSet.has(c)) return c;
  return null;
}

// ---- build graph --------------------------------------------------------------
function build() {
  const roots = workspaceRoots();
  const pkgIndex = packageIndexMap(roots);

  const files = [];
  for (const root of roots) walk(join(root, 'src'), files);
  files.sort();

  const relFiles = files.map(rel);
  const fileSet = new Set(relFiles);

  const nodes = [];
  const edges = [];
  const seenEdge = new Set();

  for (const full of files) {
    const path = rel(full);
    const file = basename(path);
    const pkg = path.split('/').slice(0, 2).join('/');
    const src = readFileSync(full, 'utf8');
    const loc = src.length ? src.split('\n').length : 0;

    const exports = extractExports(src).sort();
    const specifiers = extractSpecifiers(src);
    const imports = [];
    for (const spec of specifiers) {
      const resolved = resolveSpec(spec, path, fileSet, pkgIndex);
      if (resolved) {
        if (!imports.includes(resolved)) imports.push(resolved);
        const key = `${path}\x00${resolved}`;
        if (resolved !== path && !seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push({ from: path, to: resolved });
        }
      } else if (spec.startsWith('@bettertrack/') && !imports.includes(spec)) {
        imports.push(spec); // workspace pkg with no resolvable src entry (e.g. config)
      }
    }
    imports.sort();

    nodes.push({ path, package: pkg, kind: classify(path, file, pkg), exports, imports, loc });
  }

  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { generatedAt: new Date().toISOString(), nodes, edges };
}

// ---- MAP.md rendering ---------------------------------------------------------
function renderMap(graph) {
  const byDir = new Map();
  for (const n of graph.nodes) {
    const dir = posix.dirname(n.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(n);
  }
  const dirs = [...byDir.keys()].sort();

  const out = [];
  out.push('# BetterTrack module map');
  out.push('');
  out.push(
    `Generated by factory/knowledge/build.mjs at ${graph.generatedAt}. ` +
      `${graph.nodes.length} source files, ${graph.edges.length} internal edges. ` +
      'Query graph.json with jq for imports/exports/edges. DO NOT hand-edit — regenerated each factory cycle.',
  );
  out.push('');

  for (const dir of dirs) {
    const nodes = byDir
      .get(dir)
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));
    const allTests = nodes.every((n) => n.kind === 'test');
    if (allTests) {
      // Test dirs collapse to one line — locate individually via graph.json.
      out.push(`## ${dir}/ — ${nodes.length} test files`);
    } else if (nodes.length > 25) {
      // Roll up oversized dirs: summary + the largest files by loc.
      const kinds = {};
      for (const n of nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      const kindStr = Object.entries(kinds)
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${k}:${c}`)
        .join(' ');
      out.push(`## ${dir}/ (${nodes.length} files — ${kindStr})`);
      const notable = nodes
        .slice()
        .sort((a, b) => b.loc - a.loc)
        .slice(0, 8);
      for (const n of notable) out.push(fileLine(n));
      out.push(`- …and ${nodes.length - notable.length} more (query graph.json)`);
    } else {
      out.push(`## ${dir}/ (${nodes.length})`);
      for (const n of nodes) out.push(fileLine(n));
    }
  }
  out.push('');
  out.push(
    '_Test files are collapsed to counts above; list them with ' +
      '`jq \'.nodes[]|select(.kind=="test")|.path\' factory/knowledge/graph.json`._',
  );
  return out.join('\n');
}

// Show exports only for backend-logic kinds (where an agent reasons about the
// public surface); UI/leaf files list path+kind only. Keeps the injected map lean;
// full exports for every file remain in graph.json.
const EXPORT_CAP = { domain: 5, service: 4, schema: 4, route: 4, job: 3 };
function fileLine(n) {
  const cap = EXPORT_CAP[n.kind];
  if (!cap) return `- ${basename(n.path)} — ${n.kind}`;
  const ex = n.exports.slice(0, cap).join(', ');
  const more = n.exports.length > cap ? ` +${n.exports.length - cap}` : '';
  return `- ${basename(n.path)} — ${n.kind}${ex ? ` — ${ex}${more}` : ''}`;
}

// ---- main ---------------------------------------------------------------------
const graph = build();
writeFileSync(OUT_GRAPH, JSON.stringify(graph, null, 2) + '\n');
writeFileSync(OUT_MAP, renderMap(graph) + '\n');
console.error(
  `knowledge: ${graph.nodes.length} files, ${graph.edges.length} edges -> ` +
    `${rel(OUT_GRAPH)}, ${rel(OUT_MAP)}`,
);
