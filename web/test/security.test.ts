/**
 * Static guards for the client code (widget, landing pages, Chrome extension):
 * no iframes, no environment variables or secrets, the only backend address is the public chat URL,
 * the extension asks for no permissions and never reads cookies/storage or sends data itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const list = (dir: string, re: RegExp) =>
  readdirSync(new URL(dir, root))
    .filter((f) => re.test(f))
    .map((f) => join(dir, f).replace(/\\/g, '/'));

const CLIENT = [
  ...list('web/src/', /\.ts$/),
  ...list('web/public/', /\.html$/),
  ...list('extension/', /\.(js|json)$/).filter((f) => !f.endsWith('/widget.js')),
];
const PUBLIC_API = 'https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat';

describe('client code security', () => {
  it('has no iframes, env variables or secrets', () => {
    expect(CLIENT.length).toBeGreaterThan(8);
    for (const f of CLIENT) {
      const src = read(f);
      expect(src, f).not.toMatch(/<iframe|createElement\(\s*['"]iframe/i);
      expect(src, f).not.toMatch(/process\.env|import\.meta\.env|Deno\.env/);
      expect(src, f).not.toMatch(/service_role|SUPABASE_SERVICE|ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-ant-|eyJhbGciOi/);
    }
  });

  it('talks only to the public chat function (localhost only for the mock)', () => {
    for (const f of CLIENT) {
      for (const m of read(f).matchAll(/https:\/\/[a-z0-9-]+\.supabase\.co[^\s"'<>`)]*/gi)) {
        if (!/YOUR-PROJECT/i.test(m[0])) expect(m[0], f).toBe(PUBLIC_API); // placeholder in the docs snippet
      }
    }
  });

  it('the build does not inline environment variables into the bundle', () => {
    const build = read('web/build.mjs');
    expect(build).not.toMatch(/define\s*:/);
    expect(build).not.toMatch(/process\.env|dotenv/);
  });

  it('the extension requests no permissions and does not read cookies, storage or send data itself', () => {
    const manifest = JSON.parse(read('extension/manifest.json'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toBeUndefined();
    expect(manifest.host_permissions).toBeUndefined();
    const hosts = [
      ...manifest.content_scripts.flatMap((c: any) => c.matches),
      ...manifest.web_accessible_resources.flatMap((r: any) => r.matches),
    ];
    expect(new Set(hosts)).toEqual(new Set(['https://ekt.kz/*', 'https://www.ekt.kz/*']));
    const content = read('extension/content.js');
    expect(content).not.toMatch(/document\.cookie|localStorage|sessionStorage|fetch\(|XMLHttpRequest|sendBeacon|chrome\.storage|\.value\b/);
    expect(content).toContain(PUBLIC_API);
  });
});
