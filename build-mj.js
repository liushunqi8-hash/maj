// build-mj.js — 组装 dist/worker.js（单文件 Worker + DO）
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const DIST = path.join(HERE, "dist");
fs.mkdirSync(DIST, { recursive: true });

// 1. mj core（去 export，供单文件拼接）
let core = fs.readFileSync(path.join(HERE, "shared", "mj-core.js"), "utf-8");
core = core.replace(/^export /gm, "");
if (core.includes("</script")) throw new Error("core 含 </script");

// 2. 客户端 HTML
let html = fs.readFileSync(path.join(HERE, "client-template.html"), "utf-8");
html = html.replace("/*__MJ_CORE__*/", () => core);
if (html.includes("__MJ_CORE__")) throw new Error("client 占位符未替换完");

// 3. Worker
let worker = fs.readFileSync(path.join(HERE, "worker-src.js"), "utf-8");
worker = worker.replace("/*__MJ_CORE__*/", () => core);
worker = worker.replace('"__CLIENT_HTML_JSON__"', () => JSON.stringify(html));
if (worker.includes("__MJ_CORE__") || worker.includes("__CLIENT_HTML_JSON__")) throw new Error("worker 占位符未替换完");

fs.writeFileSync(path.join(DIST, "worker.js"), worker);
fs.writeFileSync(path.join(DIST, "index.html"), html);
console.log("worker.js:", worker.length, "bytes; index.html:", html.length, "bytes");
