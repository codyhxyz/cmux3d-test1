// One entry point, because one launcher already exists: `~/.coding-cube/bin/coding-cube`
// execs this file with whatever arguments it was given, and install.sh has been writing that
// launcher since the first release. Teaching this file the subcommand means `coding-cube
// pair` works on machines that installed the cube before the command existed.
//
// A leading `-` is a flag for the server (`--cloud`, `--expose`), never a command, so the
// only word that means anything here is `pair`. Anything else is a typo, and a typo must not
// start a terminal server that was not asked for.
const word = process.argv[2];
const command = !word || word.startsWith('-') ? 'serve' : word;

if (command === 'serve') await import('./serve.js');
else if (command === 'pair') await import('../cli/pair.js');
else {
  console.error(`coding-cube: no command called ${command}. Try \`coding-cube\` or \`coding-cube pair\`.`);
  process.exitCode = 2;
}
