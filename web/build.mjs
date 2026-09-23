// Build the embeddable widget: web/src/widget.ts → web/public/widget.js
//   node web/build.mjs           production build (minified IIFE, no sourcemap)
//   node web/build.mjs --watch   rebuild on change + serve web/public on http://localhost:5173
import * as esbuild from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const outfile = resolve(here, 'public/widget.js');
const LIMIT = 40 * 1024;

/** Minify the CSS template in src/styles.ts at build time (esbuild does not touch strings). */
const minifyCss = {
  name: 'minify-css',
  setup(b) {
    b.onLoad({ filter: /[\\/]styles\.ts$/ }, async (args) => {
      const src = readFileSync(args.path, 'utf8');
      const m = /css = \/\* css \*\/ `([\s\S]*)`;/.exec(src);
      if (!m) return undefined;
      const { code } = await esbuild.transform(m[1], { loader: 'css', minify: true });
      return { contents: `export const css = ${JSON.stringify(code.trim())};`, loader: 'ts' };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src/widget.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  charset: 'utf8',
  banner: { js: '/* EKT AI consultant widget · https://ekt.kz */' },
  logLevel: 'info',
  plugins: [minifyCss],
};

function report() {
  const size = statSync(outfile).size;
  const gz = gzipSync(readFileSync(outfile)).length;
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`widget.js: ${kb(size)} (gzip ${kb(gz)}), limit ${kb(LIMIT)}`);
  if (!watch && size > LIMIT) {
    console.error('widget.js exceeds the 40 KB budget');
    process.exit(1);
  }
}

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [minifyCss, { name: 'report', setup: (b) => b.onEnd((r) => r.errors.length || report()) }],
  });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: resolve(here, 'public'), port: 5173, host: '127.0.0.1' });
  console.log(`Serving web/public on http://localhost:${port}  (mock API: node web/dev/mock-server.mjs)`);
} else {
  await esbuild.build(options);
  report();
}
