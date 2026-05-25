import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createAppServer } from '../server/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const port = 3210;
const guiUrl = 'http://127.0.0.1:3210/';

function openBrowser(url) {
  if (process.env.NO_OPEN_BROWSER === '1') {
    return;
  }

  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    console.warn(`Could not open browser automatically: ${error.message}`);
  });

  child.unref();
}

const server = createAppServer({ projectRoot });

server.on('error', (error) => {
  console.error(`GUI server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`GUI available at ${guiUrl}`);
  openBrowser(guiUrl);
});
