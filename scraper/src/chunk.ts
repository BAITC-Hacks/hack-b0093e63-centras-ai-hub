export interface ChunkInput {
  heading: string | null;
  content: string;
}

export interface Chunk {
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

/** Делит текст на куски ≤ max по границам абзацев → строк → предложений → слов. */
function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const separators = ['\n\n', '\n', /(?<=[.!?;:])\s+/, ' '];
  for (const sep of separators) {
    const parts = text.split(sep).filter((p) => p.trim());
    if (parts.length < 2) continue;
    const joiner = typeof sep === 'string' ? sep : ' ';
    const out: string[] = [];
    let cur = '';
    for (const p of parts) {
      const candidate = cur ? cur + joiner + p : p;
      if (candidate.length <= max) {
        cur = candidate;
        continue;
      }
      if (cur) out.push(cur);
      if (p.length > max) {
        out.push(...splitText(p, max));
        cur = '';
      } else {
        cur = p;
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  // одно «слово» длиннее max — режем жёстко
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** Хвост предыдущего куска для перекрытия — по границе слова. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n > 0 ? text : '';
  const t = text.slice(-n);
  const sp = t.search(/\s/);
  return (sp >= 0 ? t.slice(sp + 1) : t).trim();
}

/**
 * Секции страницы → чанки ~maxChars с небольшим перекрытием внутри длинных секций.
 * Заголовок секции переносится в каждый её чанк.
 */
export function chunkSections(sections: ChunkInput[], opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 150;
  const chunks: Chunk[] = [];
  for (const s of sections) {
    const content = s.content.trim();
    if (!content) continue;
    const pieces = splitText(content, Math.max(200, max - overlap));
    pieces.forEach((p, i) => {
      const prefix = i > 0 ? tail(pieces[i - 1], overlap) : '';
      chunks.push({ heading: s.heading, content: prefix ? `…${prefix}\n${p}` : p });
    });
  }
  // очень короткие секции без заголовка приклеиваем к предыдущему чанку
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && !c.heading && c.content.length < 150 && prev.content.length + c.content.length + 1 <= max) {
      prev.content += `\n${c.content}`;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}
