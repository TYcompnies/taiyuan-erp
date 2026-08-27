/**
 * serve.js — 轻量静态文件服务器（替代 python -m http.server）
 * 用法: node serve.js [port] [rootDir]
 * 默认: 端口 8904，根目录 = 当前目录
 * 特点: 随进程启停、无残留进程；端口冲突时自动报错退出
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2] || '8904', 10);
const root = path.resolve(process.argv[3] || '.');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // 防目录穿越
    const filePath = path.normalize(path.join(root, urlPath));
    if (!filePath.startsWith(root)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not Found: ' + urlPath);
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log('[serve.js] 静态服务器已启动: http://127.0.0.1:' + port + '  (root=' + root + ')');
});
server.on('error', (e) => {
    console.error('[serve.js] 启动失败:', e.code === 'EADDRINUSE' ? '端口 ' + port + ' 已被占用' : e.message);
    process.exit(1);
});
