import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('public');
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({mode:'preview'})); return; }
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(root + sep)) throw Error('Invalid path');
    const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[extname(path)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type}); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '0.0.0.0', () => console.log('Preview http://localhost:4173'));
