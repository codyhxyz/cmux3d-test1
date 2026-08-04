// A real, typeable shell that runs in the page itself, so a terminal is never
// dead. It is also where connecting to a computer happens, which means the empty
// state is the onboarding rather than a sign telling you to go elsewhere.

const BANNER = [
  '\x1b[38;5;39mcmux3d\x1b[0m — this terminal runs in your browser.',
  '',
  'For six real shells, run this on your computer:',
  '  \x1b[1mcurl -fsSL https://codingcube.codyh.xyz/install.sh | sh\x1b[0m',
  '',
  'This page connects by itself when it finishes. \x1b[2mhelp\x1b[0m for commands.',
  '',
];

export function createLocalShell({ term, facet, commands }) {
  let line = '';
  let cursor = 0;
  const history = [];
  let historyIndex = 0;
  let disposed = false;

  const prompt = () => `\x1b[38;5;245m${facet.name.toLowerCase()}\x1b[0m $ `;
  const write = (text) => term.write(text);
  const newline = () => write('\r\n');

  const render = () => {
    // Redraw from the prompt so edits mid-line stay correct.
    write(`\r\x1b[K${prompt()}${line}`);
    const back = line.length - cursor;
    if (back > 0) write(`\x1b[${back}D`);
  };

  const println = (text = '') => {
    write(`\r\x1b[K${text}\r\n`);
  };

  const runLine = async (input) => {
    const [name, ...args] = input.trim().split(/\s+/);
    if (!name) return;
    history.push(input);
    historyIndex = history.length;
    const command = commands[name];
    if (!command) {
      println(`\x1b[31m${name}: not found\x1b[0m  — try \x1b[1mhelp\x1b[0m`);
      return;
    }
    try {
      await command(args, { println, term });
    } catch (error) {
      println(`\x1b[31m${error.message}\x1b[0m`);
    }
  };

  const onData = term.onData(async (data) => {
    if (disposed) return;
    for (const chunk of splitKeys(data)) {
      if (chunk === '\r' || chunk === '\n') {
        newline();
        const input = line;
        line = '';
        cursor = 0;
        await runLine(input);
        render();
      } else if (chunk === '\x7f' || chunk === '\b') {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor -= 1;
          render();
        }
      } else if (chunk === '\x03') {
        write('^C');
        newline();
        line = '';
        cursor = 0;
        render();
      } else if (chunk === '\x15') {
        line = line.slice(cursor);
        cursor = 0;
        render();
      } else if (chunk === '\x01') {
        cursor = 0;
        render();
      } else if (chunk === '\x05') {
        cursor = line.length;
        render();
      } else if (chunk === '\x1b[D') {
        if (cursor > 0) { cursor -= 1; render(); }
      } else if (chunk === '\x1b[C') {
        if (cursor < line.length) { cursor += 1; render(); }
      } else if (chunk === '\x1b[A' || chunk === '\x1b[B') {
        if (!history.length) continue;
        historyIndex = clamp(historyIndex + (chunk === '\x1b[A' ? -1 : 1), 0, history.length);
        line = history[historyIndex] || '';
        cursor = line.length;
        render();
      } else if (chunk >= ' ' && !chunk.startsWith('\x1b')) {
        line = line.slice(0, cursor) + chunk + line.slice(cursor);
        cursor += chunk.length;
        render();
      }
    }
  });

  for (const row of BANNER) println(row);
  render();

  return {
    println(text) {
      if (!disposed) println(text);
    },
    reprompt() {
      if (!disposed) render();
    },
    dispose() {
      disposed = true;
      onData.dispose();
    },
  };
}

// Pasted or fast input arrives as one string; escape sequences must stay whole.
function splitKeys(data) {
  const keys = [];
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === '\x1b' && /[A-D]/.test(data[i + 2] || '') && data[i + 1] === '[') {
      keys.push(data.slice(i, i + 3));
      i += 2;
    } else {
      keys.push(data[i]);
    }
  }
  return keys;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
