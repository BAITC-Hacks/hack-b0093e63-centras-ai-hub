// Server-Sent Events: кодирование событий для клиента и декодирование входящего потока (OpenAI).

const encoder = new TextEncoder();

/** Форматирует одно SSE-событие: `event: <name>\ndata: <json>\n\n`. */
export function formatEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SSEWriter {
  send(name: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Создаёт поток text/event-stream. `run` получает writer и выполняется асинхронно;
 * поток закрывается после завершения `run`. Отключение клиента не прерывает `run`
 * (ответ всё равно сохраняется в БД), просто дальнейшие события отбрасываются.
 */
export function createSSEStream(
  run: (w: SSEWriter) => Promise<void>,
  heartbeatMs = 15_000,
): ReadableStream<Uint8Array> {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const write = (s: string) => {
    if (closed) return;
    try {
      ctrl.enqueue(encoder.encode(s));
    } catch {
      closed = true;
    }
  };

  const writer: SSEWriter = {
    send: (name, data) => write(formatEvent(name, data)),
    close: () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      try {
        ctrl.close();
      } catch { /* уже закрыт */ }
    },
    get closed() {
      return closed;
    },
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      // Комментарий-пинг, чтобы прокси не рвали соединение во время долгих вызовов инструментов.
      timer = setInterval(() => write(": ping\n\n"), heartbeatMs);
      run(writer)
        .catch((e) => console.error("sse run failed", e))
        .finally(() => writer.close());
    },
    cancel() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    },
  });
}

export interface DecodedEvent {
  event: string;
  data: string;
}

/**
 * Инкрементальный декодер SSE (для потока OpenAI). Принимает произвольные куски текста,
 * возвращает завершённые события. Поддерживает \n, \r\n, многострочные data и комментарии.
 */
export class SSEDecoder {
  private buf = "";
  private dataLines: string[] = [];
  private eventName = "";

  push(chunk: string): DecodedEvent[] {
    this.buf += chunk;
    const out: DecodedEvent[] = [];
    let idx: number;
    while ((idx = this.buf.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buf.slice(0, idx);
      const nlLen = this.buf.startsWith("\r\n", idx) ? 2 : 1;
      // "\r" в конце буфера может быть половиной "\r\n" — ждём следующий кусок.
      if (this.buf[idx] === "\r" && nlLen === 1 && idx === this.buf.length - 1) break;
      this.buf = this.buf.slice(idx + nlLen);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Досылает событие, если поток закончился без пустой строки. */
  flush(): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf);
      this.buf = "";
      if (ev) out.push(ev);
    }
    const ev = this.line("");
    if (ev) out.push(ev);
    return out;
  }

  private line(line: string): DecodedEvent | null {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventName = "";
        return null;
      }
      const ev = { event: this.eventName || "message", data: this.dataLines.join("\n") };
      this.dataLines = [];
      this.eventName = "";
      return ev;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    return null;
  }
}
