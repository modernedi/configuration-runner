#!/usr/bin/env node

import {
  exitCodeForError,
  formatCliError,
  runCli,
} from "./cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(formatCliError(error));
  process.exitCode = exitCodeForError(error);
}
