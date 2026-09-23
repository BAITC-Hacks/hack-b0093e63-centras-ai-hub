// Eval AI-консультанта: прогоняет eval/questions.json через живой API чата и проверяет ожидания.
//
//   npm run eval                       # все кейсы
//   npm run eval -- --only brand-iek   # один кейс (можно через запятую)
//
// Env: CHAT_URL (по умолчанию `${SUPABASE_URL}/functions/v1/chat`), SUPABASE_ANON_KEY (необязательно),
//      EVAL_ORIGIN (заголовок Origin, если ALLOWED_ORIGINS ограничен), EVAL_DELAY_MS (пауза между запросами).

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Expect {
  must_call?: string[];
  must_call_any?: string[];
  must_not_call?: string[];
  must_link?: boolean;
  must_contain_any?: string[];
  must_not_contain?: string[];
  refuse?: boolean;
  no_price?: boolean;
}

interface Case {
  id: string;
  category: string;
  question: string;
  followups?: string[];
  expect: Expect;
}

interface Turn {
  message: string;
  answer: string;
  tools: string[];
  products: { id: number; name: string; url: string }[];
  error: string | null;
  messageId: number | null;
  latencyMs: number;
}

interface CaseResult {
  id: string;
  category: string;
  pass: boolean;
  failures: string[];
  turns: Turn[];
}

const here = dirname(fileURLToPath(import.meta.url));

const REFUSAL_MARKERS = [
  "не могу", "не смогу", "не отвечаю", "не консультир", "не по теме", "только по", "только с", "только в",
  "к сожалению", "не относится", "не занимаюсь", "помочь с выбором", "могу помочь",
  "can't", "cannot", "only help", "i can help",
];

const PRICE_RE = /\d[\d   ]*(?:[.,]\d{1,2})?\s*(?:₸|тг|тенге|kzt)/i;

function parseArgs(argv: string[]): { only: Set<string> | null; verbose: boolean } {
  let only: Set<string> | null = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (argv[i].startsWith("--only=")) only = new Set(argv[i].slice(7).split(",").map((s) => s.trim()));
    else if (argv[i] === "--verbose" || argv[i] === "-v") verbose = true;
  }
  return { only, verbose };
}

function chatUrl(): string {
  if (process.env.CHAT_URL) return process.env.CHAT_URL;
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error("Set CHAT_URL or SUPABASE_URL");
  return `${base.replace(/\/+$/, "")}/functions/v1/chat`;
}

/** Разбирает SSE-поток ответа чата. */
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const parse = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return null;
    const raw = data.join("\n");
    try {
      return { event, data: JSON.parse(raw) as unknown };
    } catch {
      return { event, data: raw as unknown };
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const ev = parse(block);
      if (ev) yield ev;
    }
  }
  if (buf.trim()) {
    const ev = parse(buf);
    if (ev) yield ev;
  }
}

async function sendTurn(url: string, sessionId: string | null, message: string): Promise<Turn & { sessionId: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  const anon = process.env.SUPABASE_ANON_KEY;
  if (anon) {
    headers.apikey = anon;
    headers.authorization = `Bearer ${anon}`;
  }
  if (process.env.EVAL_ORIGIN) headers.origin = process.env.EVAL_ORIGIN;

  const started = Date.now();
  const turn: Turn & { sessionId: string | null } = {
    message, answer: "", tools: [], products: [], error: null, messageId: null, latencyMs: 0, sessionId,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: sessionId ?? undefined, message, page_url: "https://ekt.kz/", city: "Алматы" }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) {
      turn.error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      return turn;
    }
    for await (const ev of readSSE(res.body)) {
      const d = ev.data as Record<string, unknown>;
      switch (ev.event) {
        case "session": turn.sessionId = String(d.session_id); break;
        case "delta": turn.answer += String(d.text ?? ""); break;
        case "status": if (typeof d.tool === "string") turn.tools.push(d.tool); break;
        case "products": turn.products = (d.items as Turn["products"]) ?? []; break;
        case "done": turn.messageId = Number(d.message_id); break;
        case "error": turn.error = String(d.message ?? "error"); break;
      }
    }
  } catch (e) {
    turn.error = e instanceof Error ? e.message : String(e);
  } finally {
    turn.latencyMs = Date.now() - started;
  }
  return turn;
}

function check(c: Case, turns: Turn[]): string[] {
  const f: string[] = [];
  const e = c.expect;
  const last = turns[turns.length - 1];
  const answer = last?.answer ?? "";
  const lower = answer.toLowerCase();
  const tools = new Set(turns.flatMap((t) => t.tools));

  for (const t of turns) if (t.error) f.push(`error: ${t.error}`);
  if (!answer.trim()) f.push("empty answer");
  for (const name of e.must_call ?? []) if (!tools.has(name)) f.push(`tool not called: ${name}`);
  if (e.must_call_any?.length && !e.must_call_any.some((n) => tools.has(n))) {
    f.push(`none of tools called: ${e.must_call_any.join("|")}`);
  }
  for (const name of e.must_not_call ?? []) if (tools.has(name)) f.push(`forbidden tool called: ${name}`);
  if (e.must_link && !/https:\/\/(www\.)?ekt\.kz\//i.test(answer)) f.push("no ekt.kz link");
  if (e.must_contain_any?.length && !e.must_contain_any.some((s) => lower.includes(s.toLowerCase()))) {
    f.push(`contains none of: ${e.must_contain_any.join(" | ")}`);
  }
  for (const s of e.must_not_contain ?? []) if (lower.includes(s.toLowerCase())) f.push(`contains forbidden: "${s}"`);
  if (e.refuse) {
    if (!REFUSAL_MARKERS.some((m) => lower.includes(m))) f.push("no refusal detected");
    if (last?.products.length) f.push("refusal shows product cards");
  }
  if (e.no_price && PRICE_RE.test(answer)) f.push("answer contains a price");
  return f;
}

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n - 1) + "…" : s;
  return t + " ".repeat(Math.max(0, n - t.length));
}

async function main() {
  const { only, verbose } = parseArgs(process.argv.slice(2));
  const url = chatUrl();
  const delay = Number(process.env.EVAL_DELAY_MS ?? 500);
  const all = JSON.parse(readFileSync(join(here, "questions.json"), "utf8")) as Case[];
  const cases = only ? all.filter((c) => only.has(c.id)) : all;
  if (!cases.length) {
    console.error(`No cases matched ${only ? [...only].join(",") : ""}`);
    process.exit(2);
  }
  console.log(`Eval: ${cases.length} case(s) → ${url}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    let sessionId: string | null = null;
    const turns: Turn[] = [];
    for (const msg of [c.question, ...(c.followups ?? [])]) {
      const t = await sendTurn(url, sessionId, msg);
      sessionId = t.sessionId;
      const { sessionId: _s, ...turn } = t;
      turns.push(turn);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (t.error) break;
    }
    const failures = check(c, turns);
    const r: CaseResult = { id: c.id, category: c.category, pass: failures.length === 0, failures, turns };
    results.push(r);
    const tools = [...new Set(turns.flatMap((t) => t.tools))].join(",");
    const ms = turns.reduce((s, t) => s + t.latencyMs, 0);
    console.log(
      `${r.pass ? "PASS" : "FAIL"}  ${pad(c.id, 32)} ${pad(c.category, 13)} ${pad(tools || "-", 42)} ${String(ms).padStart(6)}ms` +
        (r.pass ? "" : `\n      ↳ ${failures.join("; ")}`),
    );
    if (verbose || !r.pass) {
      const a = turns[turns.length - 1]?.answer ?? "";
      console.log(`      ${a.replace(/\s+/g, " ").slice(0, verbose ? 2000 : 300)}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const rate = passed / results.length;
  const byCat = new Map<string, { p: number; n: number }>();
  for (const r of results) {
    const x = byCat.get(r.category) ?? { p: 0, n: 0 };
    x.n++;
    if (r.pass) x.p++;
    byCat.set(r.category, x);
  }
  console.log("\nBy category:");
  for (const [cat, x] of byCat) console.log(`  ${pad(cat, 14)} ${x.p}/${x.n}`);
  console.log(`\nPass rate: ${passed}/${results.length} = ${(rate * 100).toFixed(1)}%`);

  const reportPath = join(here, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify({ finished_at: new Date().toISOString(), chat_url: url, passed, total: results.length, pass_rate: rate, results }, null, 2),
  );
  console.log(`Report: ${reportPath}`);
  process.exit(rate < 0.8 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
