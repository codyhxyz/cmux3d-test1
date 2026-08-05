import { AttachAddon } from '/vendor/addon-attach.mjs';
import { isPageActive } from './activity.js';
import { hostWebSocket } from './connection.js';
import { accessoryKeyInput, commandKeyInput, commandPromptDirection, ctrlCode, promptLine } from './terminal-keys.js';
import { createLocalShell } from './local-shell.js';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { Terminal } from '/vendor/xterm.mjs';
import { FACETS } from './facets.js';

export class TerminalFleet {
  constructor({ slot = 0, onConnection = () => {}, onCtrlChange = () => {}, commands = {} } = {}) {
    this.slot = slot;
    this.entries = new Map();
    this.resizeObserver = new ResizeObserver(() => this.fitAll());
    this.onConnection = onConnection;
    this.onCtrlChange = onCtrlChange;
    this.commands = commands;
    this.focusedFace = null;
    this.ctrlArmed = false;
    this.openCount = 0;
    this.started = false;
    // Terminals exist from the first paint; a computer only replaces what is
    // running in them. There is no state in which you cannot type.
    this.attached = false;
  }

  // Called once a host is reachable; until then every face runs the local shell.
  attach() {
    this.attached = true;
    for (const entry of this.entries.values()) {
      if (!entry.ws && isPageActive()) this.#connect(entry);
    }
  }

  detach() {
    this.attached = false;
    for (const entry of this.entries.values()) {
      const ws = entry.ws;
      entry.ws = null;
      ws?.close();
      this.#openLocalShell(entry);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
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
      this.#armStickyCtrl(term);

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (error) {
        console.warn(`WebGL renderer unavailable for ${facet.name}; using xterm fallback`, error);
      }
      const entry = { facet, term, fit, ws: null, failures: 0, openedAt: 0, shell: null };
      this.entries.set(facet.face, entry);
      this.resizeObserver.observe(host);
      if (this.attached && isPageActive()) this.#connect(entry);
      else this.#openLocalShell(entry);
    }
  }

  focus(face) {
    const entry = this.entries.get(face);
    if (!entry) return;
    this.focusedFace = face;
    // Synchronous, inside the tap gesture: iOS only raises the soft keyboard
    // for a focus() that still carries user activation.
    entry.term.focus();
    setTimeout(() => {
      entry.fit.fit();
      entry.term.focus();
      this.#sendSize(entry);
    }, 180);
  }

  blur() {
    this.entries.get(this.focusedFace)?.term.blur();
    this.focusedFace = null;
    this.setCtrlArmed(false);
  }

  sendKey(name) {
    const entry = this.entries.get(this.focusedFace);
    if (!entry) return;
    const sequence = accessoryKeyInput(name, { applicationCursorKeys: entry.term.modes.applicationCursorKeysMode });
    if (sequence) entry.term.input(sequence);
  }

  paste(text) {
    if (text) this.entries.get(this.focusedFace)?.term.paste(text);
  }

  setCtrlArmed(armed) {
    this.ctrlArmed = armed;
    this.onCtrlChange(armed);
  }

  retryNow() {
    if (!this.attached) return;
    for (const entry of this.entries.values()) {
      if (!entry.ws) {
        entry.failures = 0;
        this.#connect(entry);
      }
    }
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
    for (const entry of this.entries.values()) {
      entry.term.options.cursorBlink = active;
      if (this.attached && active && !entry.ws) this.#connect(entry);
      if (!active && entry.ws) {
        const ws = entry.ws;
        entry.ws = null;
        ws.close();
      }
    }
  }

  // A soft keyboard has no Ctrl, so the accessory row arms it and the next
  // character is transformed before xterm sees it.
  #armStickyCtrl(term) {
    const intercept = (character) => {
      if (!this.ctrlArmed) return undefined;
      const code = ctrlCode(character);
      if (!code) return undefined;
      term.input(code);
      this.setCtrlArmed(false);
      return true;
    };

    term.textarea?.addEventListener('keydown', (event) => {
      if (event.key?.length !== 1 || !intercept(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    // Android IMEs report `Unidentified` on keydown; beforeinput carries the character.
    term.textarea?.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'insertText' || !intercept(event.data)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  #openLocalShell(entry) {
    if (entry.shell) return;
    entry.term.write('\x1b[2J\x1b[H');
    entry.shell = createLocalShell({ term: entry.term, facet: entry.facet, commands: this.commands });
  }

  #closeLocalShell(entry) {
    entry.shell?.dispose();
    entry.shell = null;
  }

  #connect(entry) {
    const ws = new WebSocket(hostWebSocket(`/ws/pty?face=${entry.facet.face}&slot=${this.slot}`));
    let attach;
    let counted = false;
    entry.ws = ws;

    ws.addEventListener('open', () => {
      entry.openedAt = Date.now();
      // The local shell hands the keyboard over to the real one.
      this.#closeLocalShell(entry);
      entry.term.write('\x1b[2J\x1b[H');
      attach = new AttachAddon(ws);
      entry.term.loadAddon(attach);
      this.#sendSize(entry);
      counted = true;
      this.openCount += 1;
      this.onConnection(this.openCount);
    });

    ws.addEventListener('close', (event) => {
      attach?.dispose();
      if (counted) {
        counted = false;
        this.openCount = Math.max(0, this.openCount - 1);
        this.onConnection(this.openCount);
      }
      if (entry.ws !== ws) return;
      entry.ws = null;
      if (event.code === 1011) {
        entry.term.write('\r\n\x1b[31mterminal unavailable; restart the server to retry\x1b[0m\r\n');
        return;
      }
      if (Date.now() - entry.openedAt >= 30_000) entry.failures = 0;
      const delay = Math.min(1000 * 2 ** entry.failures++, 60_000);
      entry.term.write(`\r\n\x1b[33mchannel closed; retrying in ${Math.ceil(delay / 1000)}s…\x1b[0m\r\n`);
      // Hand the keyboard back so the terminal stays usable while the shell is gone.
      this.#openLocalShell(entry);
      setTimeout(() => {
        if (this.attached && isPageActive() && !entry.ws) this.#connect(entry);
      }, delay);
    });
  }

  #sendSize(entry) {
    if (entry.ws?.readyState !== WebSocket.OPEN) return;
    const size = new DataView(new ArrayBuffer(8));
    size.setUint32(0, 0x43554245); // CUBE
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
