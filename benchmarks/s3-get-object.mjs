import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { UndiciHttpHandler } from "../dist/cjs/index.js";
import { run, bench, boxplot, summary } from "mitata";
import { Agent } from "undici";

// ---------------------------------------------------------------------------
// 1. Configuration from environment variables
// ---------------------------------------------------------------------------

const Bucket = process.env.TEST_BUCKET;
const Key = process.env.TEST_KEY;

if (!Bucket || !Key) {
  console.error("ERROR: TEST_BUCKET and TEST_KEY environment variables must be set.");
  console.error("Usage: TEST_BUCKET=my-bucket TEST_KEY=my-key node benchmarks/s3-get-object.mjs");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Create S3 clients with each HTTP handler
// ---------------------------------------------------------------------------

const nodeHandler = new NodeHttpHandler({
  connectionTimeout: 3000,
  requestTimeout: 30000,
});

const undiciDispatcher = new Agent({
  bodyTimeout: 30000,
  headersTimeout: 30000,
  connect: {
    timeout: 3000,
  },
});
const undiciHandler = new UndiciHttpHandler({ dispatcher: undiciDispatcher });

const s3WithNode = new S3Client({ requestHandler: nodeHandler });
const s3WithUndici = new S3Client({ requestHandler: undiciHandler });

// ---------------------------------------------------------------------------
// 3. Helper to consume the response body
// ---------------------------------------------------------------------------

async function consumeBody(response) {
  const body = response.Body;
  if (body) {
    // transformToByteArray reads the entire stream
    await body.transformToByteArray();
  }
}

// ---------------------------------------------------------------------------
// 4. Warm up both clients
// ---------------------------------------------------------------------------

console.log(`Benchmarking S3 GetObject: Bucket=${Bucket}, Key=${Key}\n`);

await consumeBody(await s3WithNode.send(new GetObjectCommand({ Bucket, Key })));
await consumeBody(await s3WithUndici.send(new GetObjectCommand({ Bucket, Key })));

// ---------------------------------------------------------------------------
// 5. Benchmarks
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – 10 sequential S3 GetObject", async () => {
      for (let i = 0; i < 10; i++) {
        const response = await s3WithNode.send(new GetObjectCommand({ Bucket, Key }));
        await consumeBody(response);
      }
    });

    bench("UndiciHttpHandler – 10 sequential S3 GetObject", async () => {
      for (let i = 0; i < 10; i++) {
        const response = await s3WithUndici.send(new GetObjectCommand({ Bucket, Key }));
        await consumeBody(response);
      }
    });
  });
});

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – 50 concurrent S3 GetObject", async () => {
      const tasks = Array.from({ length: 50 }, async () => {
        const response = await s3WithNode.send(new GetObjectCommand({ Bucket, Key }));
        await consumeBody(response);
      });
      await Promise.all(tasks);
    });

    bench("UndiciHttpHandler – 50 concurrent S3 GetObject", async () => {
      const tasks = Array.from({ length: 50 }, async () => {
        const response = await s3WithUndici.send(new GetObjectCommand({ Bucket, Key }));
        await consumeBody(response);
      });
      await Promise.all(tasks);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Run and clean up
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  nodeHandler.destroy();
  undiciHandler.destroy();
  undiciDispatcher.destroy();
  s3WithNode.destroy();
  s3WithUndici.destroy();
}
