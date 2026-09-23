#!/usr/bin/env node
// npm run seed:update — копирует свежий прогон скрапера (data/) в seed/, снимок для
// `npm run setup:local` / CI жюри. Запускать после `npm run scrape` (см. seed/README.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['products.jsonl', 'categories.jsonl', 'pages.jsonl', 'branches.json', 'scrape-report.json'];

const dataDir = path.join(root, 'data');
const seedDir = path.join(root, 'seed');

let missing = 0;
for (const name of FILES) {
  const src = path.join(dataDir, name);
  const dest = path.join(seedDir, name);
  if (!fs.existsSync(src)) {
    console.warn(`[seed:update] пропускаю ${name} — нет в data/ (запустите \`npm run scrape\` сначала)`);
    missing++;
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`[seed:update] data/${name} → seed/${name}`);
}

if (missing === FILES.length) {
  console.error('[seed:update] ни один файл не скопирован — data/ пуст?');
  process.exit(1);
}

console.log('[seed:update] готово. Обновите таблицу состава в seed/README.md перед коммитом.');
