/* 野狗不需要墓碑 · AI 主持代理服务端（零依赖，Node 18+）
   用法：DEEPSEEK_API_KEY=sk-xxx node server.js
   功能：同时托管静态网页（public/）与 /api/chat 代理，天然解决 CORS */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const UPSTREAM = process.env.UPSTREAM || 'https://api.deepseek.com/v1/chat/completions';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const AUTO_TUNNEL = process.env.AUTO_TUNNEL === '1';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || '';

/* ---------- 公网隧道管理（免账号） ---------- */
let tunnelUrl = PUBLIC_URL || null;
let tunnelProc = null;
function tryStartTunnel(){
  if (tunnelUrl || !AUTO_TUNNEL) return;
  const local = 'http://localhost:' + PORT;
  if (CLOUDFLARED_BIN){
    console.log('[tunnel] 启动 cloudflared 快速隧道…');
    tunnelProc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', local, '--no-autoupdate'], {stdio: ['ignore','pipe','pipe']});
    const read = d => {
      const s = String(d);
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) tunnelUrl = m[0];
    };
    tunnelProc.stdout.on('data', read);
    tunnelProc.stderr.on('data', read);
    return;
  }
  // 默认 localhost.run（Windows 自带 OpenSSH）
  console.log('[tunnel] 启动 localhost.run 快速隧道…');
  tunnelProc = spawn('ssh', [
    '-o','StrictHostKeyChecking=no',
    '-o','UserKnownHostsFile=NUL',
    '-o','ServerAliveInterval=30',
    '-o','ExitOnForwardFailure=yes',
    '-R','80:' + local.replace('http://',''),
    'nokey@localhost.run'
  ], {stdio: ['ignore','pipe','pipe']});
  const read = d => {
    const s = String(d);
    const m = s.match(/https:\/\/[a-z0-9-]+\.lhr\.life/);
    if (m) tunnelUrl = m[0];
  };
  tunnelProc.stdout.on('data', read);
  tunnelProc.stderr.on('data', read);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

function send(res, code, body, type){
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname === '/api/health'){
    return send(res, 200, JSON.stringify({ok: true, dm: !!API_KEY}), 'application/json');
  }
  if (url.pathname === '/api/tunnel-url'){
    return send(res, 200, JSON.stringify({
      url: tunnelUrl,
      public: !!tunnelUrl,
      local: 'http://localhost:' + PORT
    }), 'application/json');
  }
  if (url.pathname === '/manifest.webmanifest'){
    return send(res, 200, JSON.stringify({
      name: '野狗不需要墓碑',
      short_name: '野狗剧本杀',
      description: '多人联机 · 全自动 AI 主持剧本杀',
      start_url: '/',
      display: 'standalone',
      background_color: '#0b0a08',
      theme_color: '#0b0a08',
      icons: [
        {src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png'},
        {src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png'}
      ]
    }), 'application/manifest+json');
  }
  if (url.pathname === '/sw.js'){
    const sw = `const CACHE='wdnb-v2';self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/'])).then(()=>self.skipWaiting()));});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||!e.request.url.startsWith(self.location.origin))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request)));return;}e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return res;})));});`;
    return send(res, 200, sw, 'application/javascript');
  }
  if (url.pathname === '/favicon.ico'){
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'icons', 'icon-192.png')), 'image/png');
  }
  if (url.pathname === '/api/chat' && req.method === 'POST'){
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try{
        const payload = JSON.parse(body || '{}');
        const upstream = payload.upstream || UPSTREAM;
        // 优先用服务端环境变量密钥；桌面应用场景下回退到请求头里的 Key（仅本机使用）
        const reqKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const useKey = API_KEY || reqKey;
        if (!useKey) return send(res, 400, JSON.stringify({error: '未提供 API Key（服务端环境变量或请求头）'}), 'application/json');
        const upstreamBody = {
          model: payload.model || 'deepseek-chat',
          messages: Array.isArray(payload.messages) ? payload.messages : [],
          temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.85,
          max_tokens: payload.max_tokens || 500,
          stream: false
        };
        const r = await fetch(upstream, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + useKey
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(60000)
        });
        const txt = await r.text();
        res.writeHead(r.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(txt);
      }catch(e){
        send(res, 500, JSON.stringify({error: String(e && e.message || e)}), 'application/json');
      }
    });
    return;
  }
  // 静态资源
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const fp = path.normalize(path.join(PUBLIC, file));
  if (!fp.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log('[wdnb-dm] server on http://0.0.0.0:' + PORT + ' (dm=' + (API_KEY ? 'on' : 'off') + ')');
  try{ fs.writeFileSync(path.join(__dirname, 'server.pid'), String(process.pid)); }catch(e){}
  tryStartTunnel();
});
