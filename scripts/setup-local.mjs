#!/usr/bin/env node
// npm run setup:local — поднимает локальный Supabase (Docker), применяет миграции и грузит
// seed/ (снимок ekt.kz), чтобы AI-консультанта можно было запустить без облачных ключей команды.
//
// Шаги: docker info → supabase start → supabase db reset --local → supabase status -o env →
// .env.local.generated → ingest --dir seed (с локальными SUPABASE_URL/KEY).
//
// Требует: Docker Desktop запущен, свой OPENAI_API_KEY в .env.local (иначе грузим без
// эмбеддингов — векторный поиск будет выключен, но текстовый поиск и чат работают).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const FORCE_NO_EMBED = args.includes('--no-embed');

const log = (msg) => console.log(`\n[setup-local] ${msg}`);
const fail = (msg, code = 1) => {
  console.error(`\n[setup-local] ОШИБКА: ${msg}`);
  process.exit(code);
};

/** Запускает команду через shell (кроссплатформенно резолвит npx/npx.cmd), вывод — в консоль. */
function run(command, { cwd = root, env = process.env } = {}) {
  console.log(`\n$ ${command}`);
  const res = spawnSync(command, { cwd, env, shell: true, stdio: 'inherit' });
  if (res.error) fail(`не удалось выполнить «${command}»: ${res.error.message}`);
  return res.status ?? 0;
}

/** То же самое, но с захватом stdout (для `supabase status -o env`). */
function capture(command, { cwd = root, env = process.env } = {}) {
  const res = spawnSync(command, { cwd, env, shell: true, encoding: 'utf8' });
  if (res.error) fail(`не удалось выполнить «${command}»: ${res.error.message}`);
  return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// 1. Docker
// ---------------------------------------------------------------------------

log('проверяю Docker (docker info)…');
{
  const res = spawnSync('docker', ['info'], { shell: true, stdio: 'ignore' });
  if (res.error || res.status !== 0) {
    fail(
      'Docker недоступен. Локальный стек Supabase запускается в контейнерах — нужен запущенный ' +
        'Docker Desktop (или совместимый движок). Запустите Docker Desktop и повторите ' +
        '`npm run setup:local`.',
    );
  }
}
console.log('[setup-local] Docker в порядке.');

// ---------------------------------------------------------------------------
// 2. supabase start
// ---------------------------------------------------------------------------

log('запускаю локальный Supabase (npx supabase start)…');
if (run('npx supabase start') !== 0) {
  fail('`supabase start` завершился с ошибкой — см. вывод выше.');
}

// ---------------------------------------------------------------------------
// 3. supabase db reset --local (применяет миграции из supabase/migrations)
// ---------------------------------------------------------------------------

log('применяю миграции (npx supabase db reset --local)…');
if (run('npx supabase db reset --local') !== 0) {
  fail('`supabase db reset --local` завершился с ошибкой — см. вывод выше.');
}

// ---------------------------------------------------------------------------
// 4. supabase status -o env → локальные URL/ключи
// ---------------------------------------------------------------------------

log('читаю локальные URL и ключи (npx supabase status -o env)…');
const statusRes = capture('npx supabase status -o env');
if (statusRes.status !== 0) {
  fail(`«supabase status -o env» завершился с ошибкой:\n${statusRes.stderr || statusRes.stdout}`);
}

/** Парсит вывод `KEY=value` / `KEY="value"` построчно. */
function parseEnvOutput(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const statusVars = parseEnvOutput(statusRes.stdout);
const LOCAL_URL = statusVars.API_URL;
const LOCAL_SERVICE_KEY = statusVars.SERVICE_ROLE_KEY;
const LOCAL_ANON_KEY = statusVars.ANON_KEY;
if (!LOCAL_URL || !LOCAL_SERVICE_KEY) {
  fail(
    `не нашёл API_URL / SERVICE_ROLE_KEY в выводе «supabase status -o env» (ключи в CLI могли ` +
      `измениться — проверьте вручную). Сырой вывод:\n${statusRes.stdout}`,
  );
}
console.log(`[setup-local] локальный API: ${LOCAL_URL}`);

// ---------------------------------------------------------------------------
// 5. .env.local.generated (не трогаем .env.local)
// ---------------------------------------------------------------------------

const generatedPath = path.join(root, '.env.local.generated');
const generatedBody =
  `# Сгенерировано scripts/setup-local.mjs (${new Date().toISOString()}). Не редактировать руками —\n` +
  `# перезаписывается при каждом запуске \`npm run setup:local\`. Значения локального Supabase\n` +
  `# (из \`supabase status -o env\`). .env.local (ваши ключи) этот файл не трогает.\n` +
  `SUPABASE_URL=${LOCAL_URL}\n` +
  `SUPABASE_SERVICE_ROLE_KEY=${LOCAL_SERVICE_KEY}\n` +
  (LOCAL_ANON_KEY ? `SUPABASE_ANON_KEY=${LOCAL_ANON_KEY}\n` : '');
fs.writeFileSync(generatedPath, generatedBody, 'utf8');
console.log(`[setup-local] записал ${path.relative(root, generatedPath)}`);

// ---------------------------------------------------------------------------
// 6. ingest --dir seed (локальные URL/ключ — через env дочернего процесса; dotenv их не
//    перезапишет, т.к. по умолчанию override:false — см. ingest.ts: dotenv.config({...}))
// ---------------------------------------------------------------------------

const envLocalPath = path.join(root, '.env.local');
const envLocalVars = fs.existsSync(envLocalPath) ? dotenv.parse(fs.readFileSync(envLocalPath)) : {};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envLocalVars.OPENAI_API_KEY || '';

let noEmbed = FORCE_NO_EMBED;
if (!OPENAI_API_KEY && !noEmbed) {
  console.warn(
    '\n[setup-local] ПРЕДУПРЕЖДЕНИЕ: OPENAI_API_KEY не задан (ни в окружении, ни в .env.local) — ' +
      'загружаю без эмбеддингов (--no-embed). Векторный поиск будет выключен, пока вы не зададите ' +
      'ключ и не перезапустите `npm run ingest:seed`.',
  );
  noEmbed = true;
}

log(`загружаю seed/ в локальную БД (ingest${noEmbed ? ' --no-embed' : ''})…`);
const ingestEnv = {
  ...process.env,
  SUPABASE_URL: LOCAL_URL,
  SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_KEY,
  OPENAI_API_KEY,
};
const ingestArgs = ['scraper/src/ingest.ts', '--dir', 'seed'];
if (noEmbed) ingestArgs.push('--no-embed');
const ingestCmd = `npx tsx ${ingestArgs.join(' ')}`;
if (run(ingestCmd, { env: ingestEnv }) !== 0) {
  fail('ingest завершился с ошибкой — см. вывод выше.');
}

// ---------------------------------------------------------------------------
// 7. Готово — что дальше
// ---------------------------------------------------------------------------

console.log(`
[setup-local] Готово! Локальный Supabase поднят, seed/ загружен.

Дальше (в двух отдельных терминалах):

  npx supabase functions serve chat --no-verify-jwt --env-file .env.local
  npm run dev:web

Затем откройте:

  http://localhost:5173/?api=http://127.0.0.1:54321/functions/v1/chat

Supabase Studio: http://127.0.0.1:54323
`);
