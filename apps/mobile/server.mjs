import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    const htmlPath = path.join(PUBLIC_DIR, "index.html");
    const content = fs.readFileSync(htmlPath, "utf8");
    res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
    return res.end(content);
  }

  if (pathname.startsWith("/assets/")) {
    const rel = pathname.replace(/^\/assets\//, "");
    const filePath = path.join(ASSETS_DIR, rel);
    if (filePath.startsWith(ASSETS_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*"
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const PORT = Number(process.env.PORT || 4200);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Balashikshana Interactive App] Running on http://localhost:${PORT}`);
});
