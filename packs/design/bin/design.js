#!/usr/bin/env node
import { main } from '../src/cli.js';

const { code, out } = main(process.argv.slice(2));
process.stdout.write(JSON.stringify(out) + '\n');
process.exitCode = code;
