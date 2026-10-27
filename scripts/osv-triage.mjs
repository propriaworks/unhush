#!/usr/bin/env node
/**
 * osv-triage.mjs
 * Splits osv-scanner findings into packages that ship in the app and packages used only to
 * build or test it. Only the first group fails (exit 1); the second is reported as warnings.
 *
 * Usage: node scripts/osv-triage.mjs <osv-results.json> [pnpm-lock.yaml]
 */

import { readFileSync } from 'fs';

// Everything in package.json is a devDependency because Vite bundles the renderer's libraries
// into dist/, so package.json can't tell us what ships. These are the packages the app imports
// at runtime; their dependencies are followed through the lockfile. Update when adding one.
const BUNDLED_ROOTS = ['react', 'react-dom', '@ricky0123/vad-web'];
// Electron is the runtime itself. Its npm dependencies only download it, so they don't ship.
const RUNTIME_ONLY = ['electron'];

const [resultsPath, lockPath = 'pnpm-lock.yaml'] = process.argv.slice(2);
if (!resultsPath) {
  console.error('Usage: node scripts/osv-triage.mjs <osv-results.json> [pnpm-lock.yaml]');
  process.exit(2);
}

// "react-dom@19.3.1(react@19.3.1)" -> ["react-dom", "19.3.1"]; the (...) suffix lists peers
function splitKey(key) {
  const base = key.replace(/\(.*$/, '');
  const at = base.lastIndexOf('@');
  return [base.slice(0, at), base.slice(at + 1)];
}

// Reads the lockfile's `snapshots:` section into Map<snapshot key, dependency snapshot keys>.
// pnpm 11+ prepends a separate YAML document for the package manager itself, so use the last one.
function readSnapshots(lockText) {
  const doc = lockText.split(/^---$/m).pop();
  const lines = doc.slice(doc.indexOf('\nsnapshots:\n')).split('\n');
  const snapshots = new Map();
  let deps = null;
  let inDeps = false;
  for (const line of lines) {
    let m;
    if ((m = line.match(/^  '?([^'\s]+?)'?:/))) {
      deps = [];
      snapshots.set(m[1], deps);
      inDeps = false;
    } else if ((m = line.match(/^    (\w+):/))) {
      inDeps = m[1] === 'dependencies' || m[1] === 'optionalDependencies';
    } else if (inDeps && (m = line.match(/^      '?([^'\s]+?)'?: (\S+)/))) {
      deps.push(`${m[1]}@${m[2]}`);
    }
  }
  return snapshots;
}

// Returns the set of "name@version" that end up in the packaged app
function shippedPackages(snapshots) {
  const shipped = new Set();
  const visited = new Set();
  const visit = key => {
    // Type declarations (e.g. protobufjs -> @types/node) contain no runtime code
    if (visited.has(key) || splitKey(key)[0].startsWith('@types/')) return;
    visited.add(key);
    shipped.add(splitKey(key).join('@'));
    for (const dep of snapshots.get(key) ?? []) visit(dep);
  };
  for (const root of [...BUNDLED_ROOTS, ...RUNTIME_ONLY]) {
    const keys = [...snapshots.keys()].filter(k => splitKey(k)[0] === root);
    // A root missing from the lockfile means the list above is stale
    if (keys.length === 0) throw new Error(`${root} not found in ${lockPath}; update osv-triage.mjs`);
    for (const key of keys) {
      if (RUNTIME_ONLY.includes(root)) shipped.add(splitKey(key).join('@'));
      else visit(key);
    }
  }
  return shipped;
}

const shipped = shippedPackages(readSnapshots(readFileSync(lockPath, 'utf8')));
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

const blocking = [];
const buildOnly = [];
for (const { packages } of results.results ?? []) {
  for (const { package: pkg, groups } of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    const advisories = groups.map(g => `${g.ids[0]} (CVSS ${g.max_severity || '?'})`).join(', ');
    (shipped.has(id) ? blocking : buildOnly).push(`${id}: ${advisories}`);
  }
}

// In CI, emit workflow annotations so findings show on the run's summary page. GitHub only
// recognises them at the start of a line, so they replace the indent.
const prefix = level => (process.env.GITHUB_ACTIONS ? `::${level}::` : '  ');

console.log(`Shipped in the app (${blocking.length} affected):`);
for (const line of blocking) console.log(`${prefix('error')}${line}`);
console.log(`Build/test only, not blocking (${buildOnly.length} affected):`);
for (const line of buildOnly) console.log(`${prefix('warning')}${line}`);
console.log('Details: https://osv.dev/<advisory id>');

process.exit(blocking.length > 0 ? 1 : 0);
