import { createServer } from "node:http";
import { once } from "node:events";
import { HttpRequest } from "@smithy/protocol-http";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { UndiciHttpHandler } from "../dist/cjs/index.js";
import { run, bench, boxplot, summary } from "mitata";

// ---------------------------------------------------------------------------
// 1. Spin up a local HTTP server
// ---------------------------------------------------------------------------

const RESPONSE_BODY = JSON.stringify({ ok: true, ts: Date.now() });

const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(RESPONSE_BODY),
  });
  res.end(RESPONSE_BODY);
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

// ---------------------------------------------------------------------------
// 2. Helper to build a Smithy HttpRequest targeting the local server
// ---------------------------------------------------------------------------

function makeRequest(overrides = {}) {
  return Object.assign(
    new HttpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: "/",
      headers: {},
    }),
    overrides,
  );
}

// Drain the response body so the connection can be reused.
async function drain(response) {
  if (response.body) {
    // response.body is a Readable / async iterable from both handlers
    for await (const _ of response.body) {
      // discard
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Create handler instances
// ---------------------------------------------------------------------------

const nodeHandler = new NodeHttpHandler({
  connectionTimeout: 3000,
  requestTimeout: 3000,
});

const undiciHandler = new UndiciHttpHandler({
  connectionTimeout: 3000,
  requestTimeout: 3000,
});

// Warm up both handlers so first-request setup cost is excluded.
await drain((await nodeHandler.handle(makeRequest())).response);
await drain((await undiciHandler.handle(makeRequest())).response);

// ---------------------------------------------------------------------------
// 4. Benchmarks
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – 10 sequential GETs", async () => {
      for (let i = 0; i < 10; i++) {
        const { response } = await nodeHandler.handle(makeRequest());
        await drain(response);
      }
    });

    bench("UndiciHttpHandler – 10 sequential GETs", async () => {
      for (let i = 0; i < 10; i++) {
        const { response } = await undiciHandler.handle(makeRequest());
        await drain(response);
      }
    });
  });
});

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – 50 concurrent GETs", async () => {
      const tasks = Array.from({ length: 50 }, async () => {
        const { response } = await nodeHandler.handle(makeRequest());
        await drain(response);
      });
      await Promise.all(tasks);
    });

    bench("UndiciHttpHandler – 50 concurrent GETs", async () => {
      const tasks = Array.from({ length: 50 }, async () => {
        const { response } = await undiciHandler.handle(makeRequest());
        await drain(response);
      });
      await Promise.all(tasks);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Run and clean up
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  nodeHandler.destroy();
  undiciHandler.destroy();
  server.close();
}
