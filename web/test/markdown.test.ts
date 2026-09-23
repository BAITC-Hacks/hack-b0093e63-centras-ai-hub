import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../src/markdown';

/** Every tag the renderer is allowed to emit. */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

function tags(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
}

function assertSafe(html: string) {
  for (const t of tags(html)) expect(ALLOWED_TAGS.has(t), `unexpected tag <${t}> in ${html}`).toBe(true);
  // No event handler attributes and no script-ish URLs anywhere in markup.
  const markup = html.replace(/>[^<]*</g, '><'); // drop text nodes, keep tags
  expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  expect(markup).not.toMatch(/javascript:/i);
  expect(markup).not.toMatch(/data:/i);
  for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^https?:\/\//);
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('renderMarkdown — formatting', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders paragraphs and line breaks', () => {
    expect(renderMarkdown('Первая строка\nвторая\n\nНовый абзац')).toBe('<p>Первая строка<br>вторая</p><p>Новый абзац</p>');
  });

  it('renders bold, italic and inline code', () => {
    expect(renderMarkdown('**Цена:** *на сайте* `ВА47-29`')).toBe(
      '<p><strong>Цена:</strong> <em>на сайте</em> <code>ВА47-29</code></p>',
    );
    expect(renderMarkdown('__жирный__ и _курсив_')).toBe('<p><strong>жирный</strong> и <em>курсив</em></p>');
  });

  it('does not italicise snake_case or multiplication', () => {
    expect(renderMarkdown('file_name_here и 2 * 3 * 4')).toBe('<p>file_name_here и 2 * 3 * 4</p>');
  });

  it('keeps markdown inside code literal', () => {
    expect(renderMarkdown('`**not bold** [x](https://a.kz)`')).toBe('<p><code>**not bold** [x](https://a.kz)</code></p>');
  });

  it('renders http(s) links with rel=noopener', () => {
    const html = renderMarkdown('[Автомат 25А](https://ekt.kz/catalog/avtomat-25a/)');
    expect(html).toBe(
      '<p><a href="https://ekt.kz/catalog/avtomat-25a/" target="_blank" rel="noopener noreferrer">Автомат 25А</a></p>',
    );
  });

  it('escapes ampersands in link URLs', () => {
    expect(renderMarkdown('[x](https://ekt.kz/?a=1&b=2)')).toContain('href="https://ekt.kz/?a=1&amp;b=2"');
  });

  it('formats link text but not the URL', () => {
    expect(renderMarkdown('[**Лампа** `E27`](https://ekt.kz/lamp_a_b/)')).toBe(
      '<p><a href="https://ekt.kz/lamp_a_b/" target="_blank" rel="noopener noreferrer"><strong>Лампа</strong> <code>E27</code></a></p>',
    );
  });

  it('autolinks bare URLs and leaves trailing punctuation outside', () => {
    expect(renderMarkdown('См. https://ekt.kz/about/contacts/.')).toBe(
      '<p>См. <a href="https://ekt.kz/about/contacts/" target="_blank" rel="noopener noreferrer">https://ekt.kz/about/contacts/</a>.</p>',
    );
  });

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('Варианты:\n- один\n- **два**\n\n1. first\n2. second')).toBe(
      '<p>Варианты:</p><ul><li>один</li><li><strong>два</strong></li></ul><ol><li>first</li><li>second</li></ol>',
    );
  });

  it('keeps the start number of an ordered list', () => {
    expect(renderMarkdown('3. три\n4. четыре')).toBe('<ol start="3"><li>три</li><li>четыре</li></ol>');
  });

  it('accepts • bullets and 1) numbering', () => {
    expect(renderMarkdown('• a\n• b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1) a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders headings as bold paragraphs', () => {
    expect(renderMarkdown('### Итого')).toBe('<p class="md-h"><strong>Итого</strong></p>');
  });

  it('renders simple pipe tables', () => {
    const html = renderMarkdown('| Товар | Цена |\n|---|---:|\n| Лампа | 1 200 ₸ |\n| Автомат | **3 400 ₸** |');
    expect(html).toBe(
      '<div class="md-table"><table><thead><tr><th>Товар</th><th>Цена</th></tr></thead><tbody>' +
        '<tr><td>Лампа</td><td>1 200 ₸</td></tr><tr><td>Автомат</td><td><strong>3 400 ₸</strong></td></tr></tbody></table></div>',
    );
  });

  it('tolerates incomplete markdown mid-stream', () => {
    expect(renderMarkdown('**Цена на сай')).toBe('<p>**Цена на сай</p>');
    const partial = renderMarkdown('[Лампа](https://ekt.');
    expect(partial.startsWith('<p>[Лампа](')).toBe(true);
    assertSafe(partial);
  });
});

describe('renderMarkdown — XSS safety', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<svg/onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '[click](javascript:alert(1))',
    '[click](javascript:alert%281%29)',
    '[click](JAVASCRIPT:alert(1))',
    '[click]( javascript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[click](vbscript:msgbox(1))',
    '[x](https://ekt.kz/"onmouseover="alert(1))',
    '[x](https://ekt.kz/" onmouseover="alert(1))',
    "[x](https://ekt.kz/'onmouseover='alert(1))",
    'https://ekt.kz/"><img src=x onerror=alert(1)>',
    "https://ekt.kz/'onfocus='alert(1)' autofocus",
    '**<img src=x onerror=alert(1)>**',
    '`<script>alert(1)</script>`',
    '- <iframe src="javascript:alert(1)"></iframe>',
    '| <b onclick=alert(1)>a</b> | b |\n|---|---|\n| <img onerror=x> | c |',
    '[<img src=x onerror=alert(1)>](https://ekt.kz/)',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    String.fromCharCode(0xe000) + '0' + String.fromCharCode(0xe000) + '<img onerror=x>',
  ];

  for (const p of payloads) {
    it(`neutralises ${JSON.stringify(p).slice(0, 60)}`, () => assertSafe(renderMarkdown(p)));
  }

  it('shows injected HTML as visible text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('leaves javascript: markdown links as literal text', () => {
    expect(renderMarkdown('[click](javascript:alert(1))')).toBe('<p>[click](javascript:alert(1))</p>');
  });

  it('never lets a quote escape the href attribute', () => {
    const html = renderMarkdown('https://ekt.kz/"onmouseover="alert(1)');
    expect(html).toContain('href="https://ekt.kz/"');
    expect(html).toContain('&quot;onmouseover=&quot;alert(1)');
  });

  it('double-escapes pre-escaped entities instead of decoding them', () => {
    expect(renderMarkdown('&lt;b&gt;')).toBe('<p>&amp;lt;b&amp;gt;</p>');
  });
});
