'use strict';

// Static preview only. Multiplayer authority belongs to tankwar-server (Haskell).
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || process.argv[2] || 5173);
// Default to all interfaces so other devices on the same private Wi-Fi can
// load the client. Set HOST=127.0.0.1 when a localhost-only preview is wanted.
const host = process.env.HOST || process.argv[3] || '0.0.0.0';
const root = __dirname;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(root, `.${pathname}`);
  const relative = path.relative(root, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404).end('Not Found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(port, host, () => {
  const localUrl = `http://127.0.0.1:${port}/`;
  console.log(`TankWar web preview: ${localUrl}`);
  if (host === '0.0.0.0' || host === '::') {
    console.log(`LAN enabled: open http://<HOST-LAN-IP>:${port}/ on another device.`);
  }
  console.log('Online mode connects to the Haskell WebSocket server on port 8080 by default.');
});
