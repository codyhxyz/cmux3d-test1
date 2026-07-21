import { AttachAddon } from '/vendor/addon-attach.mjs';
import { companionWebSocket } from './connection.js';
import { commandKeyInput, commandPromptDirection, promptLine } from './terminal-keys.js';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { Terminal } from '/vendor/xterm.mjs';
import { FACETS } from './facets.js';

export class TerminalFleet {
  constructor({ slot = 0 } = {}) {
    this.slot = slot;
    this.entries = new Map();
    this.resizeObserver = new ResizeObserver(() => this.fitAll());
  }

  start() {
    for (const facet of FACETS) {
      const host = document.getElementById(`terminal-${facet.face}`);
      if (!host) continue;

      const term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.12,
        allowTransparency: true,
        theme: terminalTheme(facet),
      });

      const prompts = new Set();
      // ponytail: Herdr exposes no prompt marks; track submissions from this page until it does.
      term.onData((data) => {
        if ((!data.includes('\r') && !data.includes('\n')) || term.buffer.active.type !== 'normal') return;
        const marker = term.registerMarker();
        if (!marker) return;
        prompts.add(marker);
        marker.onDispose(() => prompts.delete(marker));
      });
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const input = commandKeyInput(event);
        const promptDirection = commandPromptDirection(event);
        if (!input && !promptDirection) return true;
        event.preventDefault();
        event.stopPropagation();
        if (input) term.input(input);
        else jumpPrompt(term, prompts, promptDirection);
        return false;
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (error) {
        console.warn(`WebGL renderer unavailable for ${facet.name}; using xterm fallback`, error);
      }
      term.write(`\x1b[36mopening ${facet.name.toLowerCase()} channel…\x1b[0m\r\n`);

      const entry = { facet, host, term, fit, ws: null, failures: 0, openedAt: 0 };
      this.entries.set(facet.face, entry);
      this.resizeObserver.observe(host);
      this.#connect(entry);
    }

    window.addEventListener('resize', () => this.fitAll());
    setTimeout(() => this.fitAll(), 150);
  }

  focus(face) {
    const entry = this.entries.get(face);
    if (!entry) return;
    setTimeout(() => {
      entry.fit.fit();
      entry.term.focus();
      this.#sendSize(entry);
    }, 180);
  }

  fitAll() {
    for (const entry of this.entries.values()) {
      try {
        entry.fit.fit();
        this.#sendSize(entry);
      } catch {
        // Hidden or not yet laid out.
      }
    }
  }

  setWindowActive(active) {
    for (const { term } of this.entries.values()) term.options.cursorBlink = active;
  }

  #connect(entry) {
    const ws = new WebSocket(companionWebSocket(`/ws/pty?face=${entry.facet.face}&slot=${this.slot}`));
    entry.ws = ws;

    ws.addEventListener('open', () => {
      entry.openedAt = Date.now();
      entry.term.loadAddon(new AttachAddon(ws));
      this.#sendSize(entry);
    });

    ws.addEventListener('close', (event) => {
      if (entry.ws !== ws) return;
      if (event.code === 1011) {
        entry.term.write('\r\n\x1b[31mterminal unavailable; restart the server to retry\x1b[0m\r\n');
        return;
      }
      if (Date.now() - entry.openedAt >= 30_000) entry.failures = 0;
      const delay = Math.min(1000 * 2 ** entry.failures++, 60_000);
      entry.term.write(`\r\n\x1b[33mchannel closed; retrying in ${Math.ceil(delay / 1000)}s…\x1b[0m\r\n`);
      setTimeout(() => this.#connect(entry), delay);
    });
  }

  #sendSize(entry) {
    if (entry.ws?.readyState !== WebSocket.OPEN) return;
    const size = new DataView(new ArrayBuffer(8));
    size.setUint32(0, 0x434d5558); // CMUX
    size.setUint16(4, entry.term.cols);
    size.setUint16(6, entry.term.rows);
    entry.ws.send(size.buffer);
  }

}

function jumpPrompt(term, prompts, direction) {
  const buffer = term.buffer.active;
  const atBottom = buffer.viewportY === buffer.baseY;
  const anchor = atBottom ? buffer.baseY + buffer.cursorY : buffer.viewportY;
  const target = promptLine([...prompts].filter((marker) => !marker.isDisposed).map((marker) => marker.line), anchor, direction);
  if (target !== undefined) term.scrollToLine(target);
  else if (direction > 0 && !atBottom) term.scrollToBottom();
}

function terminalTheme(facet) {
  return {
    ...facet.theme,
    selectionBackground: '#ffffff2e',
    black: '#020617',
    red: '#fb7185',
    green: '#34d399',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e5e7eb',
    brightBlack: '#64748b',
    brightRed: '#fda4af',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff',
  };
}
