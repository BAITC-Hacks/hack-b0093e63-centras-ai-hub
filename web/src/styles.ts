/**
 * Widget stylesheet (lives inside the Shadow DOM, so nothing leaks either way).
 * Palette comes from ekt.kz: teal #2C7294 (navigation, links), cart-yellow #F4B301,
 * navy #0B4366; PT Sans is the site's body face. Sizes are in px on purpose:
 * host pages may redefine the root font-size.
 */
export const css = /* css */ `
:host { all: initial; }
.root {
  --accent: var(--ekt-accent, #2c7294);
  --accent-strong: var(--ekt-accent-strong, #235c78);
  --on-accent: var(--ekt-on-accent, #ffffff);
  --accent-soft: #e9f2f6;
  --accent-ring: rgba(44, 114, 148, 0.2);
  --yellow: #f4b301;
  --navy: #0b4366;
  --bg: #ffffff;
  --canvas: #f3f6f8;
  --text: #1c2830;
  --muted: #53616c;
  --line: #dce4ea;
  --line-strong: #c3d0d9;
  --danger: #b42318;
  --danger-bg: #fdf3f2;
  --danger-line: #f1cdc8;
  --radius: 12px;
  --font: "PT Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font: 15px/1.45 var(--font);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  text-align: left;
  letter-spacing: normal;
}
*, *::before, *::after { box-sizing: border-box; }
::selection { background: rgba(44, 114, 148, 0.22); }
button, textarea, input { font: inherit; color: inherit; letter-spacing: inherit; }
button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
button:disabled { cursor: default; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
svg { display: block; flex: none; }
.sr-only {
  position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ── Launcher ─────────────────────────────────────────────── */
.launcher {
  position: fixed; z-index: 2147483000;
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  right: calc(20px + env(safe-area-inset-right, 0px));
  display: inline-flex; align-items: center; gap: 9px;
  height: 52px; padding: 0 20px 0 16px;
  border: 0; border-radius: 26px;
  background: var(--accent); color: var(--on-accent);
  font-size: 15px; font-weight: 700; line-height: 1;
  box-shadow: 0 6px 18px rgba(11, 67, 102, 0.28), 0 1px 3px rgba(11, 67, 102, 0.2);
  transition: background-color .15s ease, transform .2s cubic-bezier(.2,.9,.3,1), box-shadow .2s ease, opacity .15s ease;
}
.left .launcher { right: auto; left: calc(20px + env(safe-area-inset-left, 0px)); }
.launcher:hover { background: var(--accent-strong); transform: translateY(-1px); box-shadow: 0 10px 24px rgba(11, 67, 102, 0.3), 0 2px 4px rgba(11, 67, 102, 0.2); }
.launcher:active { transform: translateY(0); }
.launcher:focus-visible { outline: 3px solid var(--yellow); outline-offset: 3px; }
.launcher svg { width: 22px; height: 22px; }
.launcher .badge {
  position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--yellow); border: 2px solid #fff; display: none;
}
.launcher.unread .badge { display: block; }
.is-open .launcher { opacity: 0; pointer-events: none; transform: scale(.9); visibility: hidden; }

/* ── Panel ────────────────────────────────────────────────── */
.panel {
  position: fixed; z-index: 2147483001;
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  right: calc(20px + env(safe-area-inset-right, 0px));
  width: 384px;
  height: min(620px, calc(100vh - 40px));
  display: flex; flex-direction: column;
  background: var(--bg);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(11, 67, 102, 0.22), 0 3px 10px rgba(11, 67, 102, 0.1);
  transform-origin: 100% 100%;
  opacity: 0; visibility: hidden; transform: translateY(14px) scale(.98);
  transition: opacity .16s ease, transform .24s cubic-bezier(.2,.9,.3,1), visibility 0s linear .24s;
}
.left .panel { right: auto; left: calc(20px + env(safe-area-inset-left, 0px)); transform-origin: 0 100%; }
.is-open .panel { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }

/* ── Header ───────────────────────────────────────────────── */
.header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 8px 12px 14px;
  background: var(--accent); color: var(--on-accent);
  border-bottom: 3px solid var(--yellow);
  flex: none;
}
.avatar {
  width: 38px; height: 38px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--yellow); color: var(--navy);
}
.avatar svg { width: 20px; height: 20px; fill: currentColor; stroke-width: 1.5; }
.heading { flex: 1; min-width: 0; }
.title { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 13px; line-height: 1.2; opacity: .92; }
.sub::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #7fe0a6; box-shadow: 0 0 0 2px rgba(255,255,255,.18); }
.hbtn {
  width: 38px; height: 38px; display: grid; place-items: center;
  border: 0; border-radius: 8px; background: transparent; color: inherit;
  transition: background-color .15s ease;
}
.hbtn:hover { background: rgba(255, 255, 255, 0.16); }
.hbtn:active { background: rgba(255, 255, 255, 0.24); }
.hbtn:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }

/* ── Message log ──────────────────────────────────────────── */
.log {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  background: var(--canvas);
  padding: 16px 14px 12px;
  display: flex; flex-direction: column; gap: 14px;
  scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
}
.log:focus-visible { outline-offset: -3px; }
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 8px; border: 2px solid var(--canvas); }
.row { display: flex; flex-direction: column; align-items: flex-start; max-width: 100%; }
.row.user { align-items: flex-end; }
.row.enter { animation: rise .18s ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }

.bubble {
  max-width: 92%;
  padding: 10px 13px;
  border-radius: 14px;
  overflow-wrap: anywhere;
  word-break: normal;
}
.assistant .bubble { background: var(--bg); border: 1px solid var(--line); border-top-left-radius: 4px; }
.user .bubble { background: var(--accent); color: var(--on-accent); border-bottom-right-radius: 4px; white-space: pre-wrap; max-width: 85%; }
.bubble:empty { display: none; }

/* Markdown */
.md p { margin: 0 0 8px; }
.md > :last-child { margin-bottom: 0; }
.md .md-h { margin-top: 12px; }
.md .md-h:first-child { margin-top: 0; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
.md li { margin: 3px 0; }
.md li::marker { color: var(--muted); }
.md strong { font-weight: 700; }
.md a { color: var(--accent-strong); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.md a:hover { text-decoration-thickness: 2px; }
.md code {
  font: 13px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: #edf2f5; border-radius: 4px; padding: 1px 5px;
}
.md-table { overflow-x: auto; margin: 0 0 8px; }
.md table { border-collapse: collapse; font-size: 13.5px; min-width: 100%; font-variant-numeric: tabular-nums; }
.md th, .md td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.md th { font-weight: 700; color: var(--muted); font-size: 12.5px; border-bottom-color: var(--line-strong); }

/* Status / typing */
.status { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; padding: 2px 0; }
.bubble + .status { margin-top: 8px; padding-left: 2px; }
.dots { display: inline-flex; gap: 4px; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: .35; animation: blink 1.2s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 80%, 100% { opacity: .3; transform: none; } 40% { opacity: 1; transform: translateY(-2px); } }

/* Welcome chips */
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; max-width: 100%; }
.chip {
  min-height: 36px; padding: 7px 12px;
  border: 1px solid var(--line-strong); border-radius: 18px;
  background: var(--bg); color: var(--accent-strong);
  font-size: 14px; line-height: 1.25; text-align: left;
  transition: background-color .15s ease, border-color .15s ease;
}
.chip:hover { background: var(--accent-soft); border-color: var(--accent); }
.chip:active { background: #dbe9f0; }

/* Product cards */
.products { display: grid; gap: 8px; margin-top: 8px; width: 92%; }
.card {
  display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px;
  padding: 10px; background: var(--bg);
  border: 1px solid var(--line); border-radius: 10px;
}
.thumb {
  width: 72px; height: 72px; border-radius: 6px;
  border: 1px solid #edf1f4; background: #fff;
  display: grid; place-items: center; overflow: hidden; color: #9aa8b3;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.thumb svg { width: 28px; height: 28px; stroke-width: 1.5; }
.pname {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  font-size: 14.5px; line-height: 1.3; font-weight: 700; color: var(--text); text-decoration: none;
}
a.pname:hover { color: var(--accent-strong); text-decoration: underline; text-underline-offset: 2px; }
.pmeta { margin-top: 3px; font-size: 12.5px; color: var(--muted); }
.prices { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; margin: 6px 0 8px; font-variant-numeric: tabular-nums; }
.price { white-space: nowrap; font-size: 13px; color: var(--muted); }
.price b { font-size: 16px; font-weight: 700; color: var(--text); margin-left: 3px; }
.price.store b { font-size: 14px; font-weight: 400; color: var(--text); }
.open {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px;
  border: 1px solid var(--accent); border-radius: 6px;
  color: var(--accent-strong); background: var(--bg);
  font-size: 13.5px; font-weight: 700; text-decoration: none;
  transition: background-color .15s ease, color .15s ease;
}
.open svg { width: 16px; height: 16px; }
.open:hover { background: var(--accent); color: var(--on-accent); }

/* Feedback */
.fb { display: flex; align-items: center; gap: 2px; margin-top: 4px; min-height: 30px; }
.fbtn {
  width: 32px; height: 30px; display: grid; place-items: center;
  border: 0; border-radius: 6px; background: transparent; color: var(--muted);
  transition: background-color .15s ease, color .15s ease;
}
.fbtn svg { width: 16px; height: 16px; }
.fbtn:hover:not(:disabled) { background: #e5ecf0; color: var(--text); }
.fbtn[aria-pressed="true"] { color: var(--accent-strong); background: var(--accent-soft); }
.fbtn:disabled:not([aria-pressed="true"]) { opacity: .45; }
.fbnote { margin-left: 6px; font-size: 12.5px; color: var(--muted); }
.fbform { display: grid; gap: 6px; margin-top: 6px; width: 92%; }
.fbform label { font-size: 13px; color: var(--muted); }
.fbform textarea {
  width: 100%; min-height: 56px; resize: vertical; padding: 8px 10px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg); font-size: 14px;
}
.fbform textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.fbactions { display: flex; gap: 8px; }

/* Shared small buttons */
.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: 6px; font-size: 13.5px; font-weight: 700; border: 1px solid var(--accent);
  background: var(--accent); color: var(--on-accent);
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.btn:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
.btn.ghost { background: transparent; color: var(--muted); border-color: transparent; }
.btn.ghost:hover { color: var(--text); background: #e5ecf0; }
.btn svg { width: 16px; height: 16px; }

/* Error */
.assistant .bubble.err { background: var(--danger-bg); border-color: var(--danger-line); color: #6f1a12; }
.errhead { display: flex; gap: 8px; align-items: flex-start; }
.errhead svg { width: 18px; height: 18px; margin-top: 1px; color: var(--danger); }
.btn.retry { margin-top: 10px; background: var(--bg); color: var(--danger); border-color: var(--danger); }
.btn.retry:hover { background: var(--danger); color: #fff; }
.btn.retry:focus-visible { outline-color: var(--danger); }
.note { margin-top: 4px; font-size: 12.5px; color: var(--muted); }

/* ── Composer ─────────────────────────────────────────────── */
.composer { flex: none; padding: 10px 12px 8px; border-top: 1px solid var(--line); background: var(--bg); }
.field {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 5px 5px 5px 12px;
  border: 1px solid var(--line-strong); border-radius: 12px; background: var(--bg);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.field.busy { background: #f8fafb; }
textarea.input {
  flex: 1; min-width: 0; display: block;
  height: 36px; max-height: 128px; padding: 7px 0; margin: 0;
  border: 0; background: transparent; resize: none; overflow-y: auto;
  font-size: 15px; line-height: 22px; color: var(--text); caret-color: var(--accent);
}
textarea.input::placeholder { color: #66737e; opacity: 1; }
textarea.input:focus-visible { outline: none; }
.send {
  width: 36px; height: 36px; display: grid; place-items: center; flex: none;
  border: 0; border-radius: 9px; background: var(--accent); color: var(--on-accent);
  transition: background-color .15s ease, opacity .15s ease;
}
.send:hover:not(:disabled) { background: var(--accent-strong); }
.send:disabled { background: #e3e9ee; color: #7d8a94; }
.send.stop { background: var(--navy); color: #fff; }
.send svg { width: 18px; height: 18px; }
.meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; }
.disclaimer { margin: 0; font-size: 11.5px; line-height: 1.35; color: var(--muted); }
.counter { font-size: 11.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.counter.over { color: var(--danger); font-weight: 700; }
.counter:empty { display: none; }

/* ── Mobile: full screen ─────────────────────────────────── */
@media (max-width: 479px) {
  .launcher { width: 56px; height: 56px; padding: 0; justify-content: center; border-radius: 50%; }
  .launcher .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .launcher .badge { top: 0; right: 0; }
  .panel, .left .panel {
    top: 0; left: 0; right: 0; bottom: 0;
    width: 100%; height: 100%;
    border-radius: 0; transform: translateY(24px);
  }
  .header { padding-top: calc(10px + env(safe-area-inset-top, 0px)); padding-left: calc(14px + env(safe-area-inset-left, 0px)); padding-right: calc(8px + env(safe-area-inset-right, 0px)); }
  .composer { padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
  textarea.input { font-size: 16px; } /* no iOS zoom on focus */
  .bubble, .products, .fbform { max-width: 100%; }
  .products { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .dots i { opacity: .7; }
}

@media (forced-colors: active) {
  .bubble, .card, .field, .chip, .launcher, .panel { border: 1px solid CanvasText; }
}
`;
