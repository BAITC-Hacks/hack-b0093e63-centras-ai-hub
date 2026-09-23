// Разбор robots.txt: группы User-agent, Allow/Disallow с шаблонами * и $, побеждает самое длинное правило.

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface Robots {
  rules: RobotsRule[];
  sitemaps: string[];
  isAllowed(url: string): boolean;
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const src = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}${anchored ? '$' : ''}`);
}

/** Правила для заданного агента: своя группа, иначе группа «*». */
export function parseRobots(text: string, agent = '*'): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === 'disallow' || key === 'allow') {
      if (!value) continue; // пустой Disallow = всё разрешено
      current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }

  const a = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  const rules: RobotsRule[] = chosen
    .flatMap((g) => g.rules)
    .map((r) => ({ ...r, pattern: safeDecode(r.pattern), regex: patternToRegex(safeDecode(r.pattern)) }));

  return {
    rules,
    sitemaps,
    isAllowed(url: string): boolean {
      let target: string;
      try {
        const u = new URL(url);
        target = safeDecode(u.pathname + u.search);
      } catch {
        target = safeDecode(url);
      }
      let best: RobotsRule | null = null;
      for (const r of rules) {
        if (!r.regex.test(target)) continue;
        if (
          !best ||
          r.pattern.length > best.pattern.length ||
          (r.pattern.length === best.pattern.length && r.allow && !best.allow)
        ) {
          best = r;
        }
      }
      return best ? best.allow : true;
    },
  };
}

export async function fetchRobots(
  origin: string,
  fetchText: (url: string) => Promise<{ status: number; body: string }>,
  agent = '*',
): Promise<Robots> {
  const res = await fetchText(new URL('/robots.txt', origin).toString());
  if (res.status >= 400) return parseRobots('', agent); // нет robots.txt — всё разрешено
  return parseRobots(res.body, agent);
}
