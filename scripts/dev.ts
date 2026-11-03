// Local run: the real handler on http://localhost:3000, backed by PGlite
// (in memory, gone on exit). Start with `npm run dev` after `cp .env.example .env`.
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "../src/handler.js";
import { pgliteDb } from "./pglite-db.js";

const port = Number(process.env.PORT ?? 3000);
const handle = createHandler({
  db: pgliteDb(new PGlite()),
  // DATABASE_URL is required by the handler but unused here.
  env: { DATABASE_URL: "pglite://memory", ...process.env },
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`site backend (PGlite) listening on http://localhost:${port}`));
