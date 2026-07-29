const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8081;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' && req.url !== '/') {
        filePath = path.join(ROOT, 'index.html');
        fs.readFile(filePath, (_, data2) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2 || 'Not Found');
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`DLS Hub running on http://localhost:${PORT}`);
});
