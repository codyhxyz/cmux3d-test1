const terminalTheme = {
  background: 'transparent',
  foreground: '#e7e5f3',
  cursor: '#76e5bd',
};

export const FACETS = [
  { face: 0, name: 'Fore', code: 'F-00', theme: terminalTheme, view: { x: -8, y: 0 } },
  { face: 1, name: 'Aft', code: 'A-01', theme: terminalTheme, view: { x: -8, y: 180 } },
  { face: 2, name: 'Starboard', code: 'S-02', theme: terminalTheme, view: { x: -8, y: -90 } },
  { face: 3, name: 'Port', code: 'P-03', theme: terminalTheme, view: { x: -8, y: 90 } },
  { face: 4, name: 'Crown', code: 'C-04', theme: terminalTheme, view: { x: -96, y: 0 } },
  { face: 5, name: 'Keel', code: 'K-05', theme: terminalTheme, view: { x: 82, y: 0 } },
];
