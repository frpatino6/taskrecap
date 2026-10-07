#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then((code) => {
  if (code !== null) process.exitCode = code; // null = the dashboard server keeps the process alive
}).catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
