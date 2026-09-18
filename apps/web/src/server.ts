import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const files: Readonly<Record<string, readonly [string, string]>> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

const server = createServer((request, response) => {
  const file = files[new URL(request.url ?? "/", "http://local").pathname];
  if (request.method !== "GET" || file === undefined) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-security-policy":
      "default-src 'self'; connect-src http://127.0.0.1:3001; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": file[1],
    "x-content-type-options": "nosniff",
  });
  createReadStream(`${publicDirectory}${file[0]}`).pipe(response);
});

if (process.env.NODE_ENV !== "test") server.listen(3000, "127.0.0.1");
export { server };
