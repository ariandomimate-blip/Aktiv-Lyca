const http = require('http');
const fs = require('fs');
const path = require('path');
require('./telegram-bot');

const port = Number(process.env.PORT) || 10000;
const root = __dirname;
const mimeTypes = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
function safePath(urlPath){const decoded=decodeURIComponent(urlPath.split('?')[0]);const relative=decoded==='/'?'index.html':decoded.replace(/^\/+/, '');const filePath=path.resolve(root,relative);return filePath.startsWith(root+path.sep)||filePath===root?filePath:null;}
const server=http.createServer((req,res)=>{let filePath;try{filePath=safePath(req.url||'/')}catch{res.writeHead(400);return res.end('Bad Request')}if(!filePath){res.writeHead(403);return res.end('Forbidden')}fs.stat(filePath,(statErr,stat)=>{if(!statErr&&stat.isFile())return sendFile(filePath,res);sendFile(path.join(root,'index.html'),res)})});
function sendFile(filePath,res){fs.readFile(filePath,(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not Found')}const ext=path.extname(filePath).toLowerCase();res.writeHead(200,{'Content-Type':mimeTypes[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});res.end(data)})}
server.listen(port,'0.0.0.0',()=>console.log(`WebSim server listening on port ${port}`));
