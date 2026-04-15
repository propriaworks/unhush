#!/usr/bin/env node
/**
 * sync-docs.mjs
 * Updates the download section of docs/index.html to match the version and
 * linux build targets in package.json.  Run locally or via CI.
 *
 * Usage: node scripts/sync-docs.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg  = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const version     = pkg.version;
const productName = pkg.build?.productName ?? pkg.name;
const pkgName     = pkg.name;                              // lowercase, used in deb/rpm filenames
const targets     = pkg.build?.linux?.target ?? ['AppImage'];
const BASE        = `https://github.com/jtbr/wisper/releases/latest/download`;

// Filename electron-builder produces for each target (Linux x86_64 defaults)
function filename(target) {
  switch (target.toLowerCase()) {
    case 'appimage': return `${productName}-${version}.AppImage`;
    case 'deb':      return `${pkgName}_${version}_amd64.deb`;
    case 'rpm':      return `${pkgName}-${version}.x86_64.rpm`;
    // pkgrel is always 1 for electron-builder pacman packages
    case 'pacman':   return `${pkgName}-${version}-1-x86_64.pkg.tar.zst`;
    default:         return null;
  }
}

const META = {
  appimage: { title: 'AppImage',        desc: 'Universal package for all Linux distros. No installation required.', btn: 'Download .AppImage'    },
  deb:      { title: 'Debian / Ubuntu / Mint', desc: 'Native .deb package for Debian-based distributions.',         btn: 'Download .deb'         },
  rpm:      { title: 'Fedora / RHEL',          desc: 'Native .rpm package for Red Hat-based distributions.',        btn: 'Download .rpm'         },
  pacman:   { title: 'Arch Linux / Manjaro',   desc: 'Native .pkg.tar.zst package for Arch Linux and derivatives.', btn: 'Download .pkg.tar.zst' },
};

const cards = targets
  .map(t => {
    const f = filename(t);
    const m = META[t.toLowerCase()];
    if (!f || !m) { console.warn(`Unknown target "${t}", skipping.`); return null; }
    return [
      `            <div class="download-card">`,
      `              <h3>${m.title}</h3>`,
      `              <p>${m.desc}</p>`,
      `              <a`,
      `                href="${BASE}/${f}"`,
      `                class="download-btn"`,
      `              >`,
      `                ${m.btn}<small>v${version}</small>`,
      `              </a>`,
      `            </div>`,
    ].join('\n');
  })
  .filter(Boolean)
  .join('\n');

const grid = [
  `          <div class="download-grid">`,
  cards,
  `          </div>`,
].join('\n');

const MARKER_START = '<!-- DOWNLOAD-CARDS-START -->';
const MARKER_END   = '<!-- DOWNLOAD-CARDS-END -->';

const htmlPath = resolve(ROOT, 'docs/index.html');
const html     = readFileSync(htmlPath, 'utf8');

if (!html.includes(MARKER_START) || !html.includes(MARKER_END)) {
  console.error(
    `docs/index.html is missing markers.\n` +
    `Add  ${MARKER_START}  and  ${MARKER_END}  around the download-grid div.`
  );
  process.exit(1);
}

const re      = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
const block   = `${MARKER_START}\n${grid}\n          ${MARKER_END}`;
const updated = html.replace(re, block);

writeFileSync(htmlPath, updated, 'utf8');
console.log(`docs/index.html updated: v${version}, targets: [${targets.join(', ')}]`);
