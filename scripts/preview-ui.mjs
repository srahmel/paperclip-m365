// Synthetic browser fixture. No Microsoft, Paperclip or other remote requests.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import esbuild from "esbuild";
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist/ui-preview");
await mkdir(output, { recursive: true });
await esbuild.build({ entryPoints: [resolve(root, "tests/ui-preview.jsx")], outfile: resolve(output, "preview.js"), bundle: true,
  platform: "browser", format: "esm", jsx: "automatic", alias: { "@paperclipai/plugin-sdk/ui": resolve(root, "tests/ui-preview-sdk.jsx") } });
const html = '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>M365 synthetic UI check</title><style>body{font:16px system-ui;margin:20px;max-width:1000px}button,input,select,textarea{font:inherit;max-width:100%;box-sizing:border-box}button{padding:.45rem;margin:.2rem}label{display:block}input,textarea{display:block;width:100%}input[type=checkbox]{display:inline;width:auto}pre,dd{overflow-wrap:anywhere}dd{margin-left:1rem}fieldset{min-width:0}button:focus-visible,input:focus-visible{outline:3px solid #1678dd}</style><div id="root"></div><script type="module" src="/preview.js"></script></html>';
const server = createServer(async (request, response) => {
  if (request.method !== "GET" || !["/", "/preview.js"].includes(request.url)) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", request.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(request.url === "/" ? html : await readFile(resolve(output, "preview.js")));
});
server.listen(3199, "127.0.0.1", () => process.stdout.write("Synthetic UI fixture: http://127.0.0.1:3199\n"));
