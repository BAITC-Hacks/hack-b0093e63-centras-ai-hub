/**
 * Safe Markdown subset for assistant replies.
 *
 * Security model: the whole input is HTML-escaped FIRST, so the only tags in the
 * output are the ones this module emits. Links are only produced for http(s) URLs
 * and always carry rel="noopener noreferrer" target="_blank" (the widget may drop
 * the target for same-site links). No attribute ever receives unescaped input.
 *
 * Supported: paragraphs, line breaks, **bold**, __bold__, *italic*, _italic_,
 * `code`, [text](https://…), bare https:// URLs, - / * / • lists, 1. lists,
 * # headings (rendered as bold paragraphs), simple | pipe | tables.
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Placeholder delimiter: a private-use char that is stripped from the input. */
const PH = String.fromCharCode(0xe000);
const PH_RE = new RegExp(PH + '(\\d+)' + PH, 'g');
const STRIP_RE = new RegExp('[' + PH + String.fromCharCode(0) + ']', 'g');
/** Bare URL: stops at whitespace, placeholders and escaped quotes/brackets. */
const BARE_URL = new RegExp('\\bhttps?://(?:(?!&quot;|&#39;|&lt;|&gt;)[^\\s<>' + PH + '])+', 'gi');

const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;

function linkHtml(url: string, text: string): string {
  // `url` is already HTML-escaped (& → &amp;, quotes → entities), so it is attribute-safe.
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** Inline formatting on an already-escaped single block of text. */
function inline(escaped: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `${PH}${slots.push(html) - 1}${PH}`;

  let s = escaped;

  // `code` — contents are literal, no further formatting.
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));

  // [text](url) — only http(s). Anything else stays as literal text.
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, text: string, url: string) => {
    if (!SAFE_URL.test(url.replace(/&amp;/g, '&'))) return m;
    return hold(linkHtml(url, emphasis(text)));
  });

  // Bare URLs. Trailing punctuation is kept outside the link.
  s = s.replace(BARE_URL, (m) => {
    const trail = /[.,;:!?)\]]+$/.exec(m);
    const url = trail ? m.slice(0, m.length - trail[0].length) : m;
    if (!SAFE_URL.test(url.replace(/&amp;/g, '&'))) return m;
    return hold(linkHtml(url, url)) + (trail ? trail[0] : '');
  });

  s = emphasis(s);

  // Restore placeholders; link text may itself hold a code span, hence the loop.
  for (let n = 0; n < 3 && s.indexOf(PH) !== -1; n++) s = s.replace(PH_RE, (_, i: string) => slots[Number(i)] ?? '');
  return s;
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
}

const UL = /^\s*[-*+•]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => inline(c.trim()));
}

/** Render Markdown to a safe HTML string. */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  const text = escapeHtml(src.replace(/\r\n?/g, '\n').replace(STRIP_RE, ''));
  const lines = text.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; start: number; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    // Table: header row + separator row + body rows.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      flushList();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push(`<p class="md-h"><strong>${inline(h[1])}</strong></p>`);
      continue;
    }

    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, start: ol ? Number(ol[1]) : 1, items: [] };
      }
      list.items.push(ul ? ul[1] : (ol as RegExpExecArray)[2]);
      continue;
    }

    // Indented continuation of a list item.
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}
