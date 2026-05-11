import { S3 } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { UndiciHttpHandler } from "../dist/cjs/index.js";
import { run, bench, boxplot, summary } from "mitata";
import { Agent } from "undici";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Configuration from environment variables
// ---------------------------------------------------------------------------

const Bucket = process.env.TEST_BUCKET;

if (!Bucket) {
  console.error("ERROR: TEST_BUCKET environment variable must be set.");
  console.error("Usage: TEST_BUCKET=my-bucket node benchmarks/s3-get-object.mjs");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Define test object sizes
// ---------------------------------------------------------------------------

const TEST_OBJECTS = [
  { name: "test-object-16KB", size: 16 * 1024 },
  { name: "test-object-32KB", size: 32 * 1024 },
  { name: "test-object-64KB", size: 64 * 1024 },
  { name: "test-object-128KB", size: 128 * 1024 },
  { name: "test-object-256KB", size: 256 * 1024 },
  { name: "test-object-512KB", size: 512 * 1024 },
  { name: "test-object-1MB", size: 1 * 1024 * 1024 },
  { name: "test-object-2MB", size: 2 * 1024 * 1024 },
  { name: "test-object-4MB", size: 4 * 1024 * 1024 },
  { name: "test-object-8MB", size: 8 * 1024 * 1024 },
  { name: "test-object-16MB", size: 16 * 1024 * 1024 },
];

// ---------------------------------------------------------------------------
// 3. Create S3 clients with each HTTP handler
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

const s3WithNode = new S3({ requestHandler: nodeHandler });
const s3WithUndici = new S3({ requestHandler: undiciHandler });

// ---------------------------------------------------------------------------
// 4. Helper to consume the response body
// ---------------------------------------------------------------------------

async function consumeBody(response) {
  const body = response.Body;
  if (body) {
    for await (const _ of body) {
      // no-op: just drain the stream
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Upload test objects
// ---------------------------------------------------------------------------

console.log(`Uploading ${TEST_OBJECTS.length} test objects to Bucket=${Bucket}...\n`);

for (const obj of TEST_OBJECTS) {
  const data = randomBytes(obj.size);
  await s3WithNode.putObject({ Bucket, Key: obj.name, Body: data });
  console.log(`  Uploaded ${obj.name} (${obj.size >= 1024 * 1024 ? `${obj.size / (1024 * 1024)}MB` : `${obj.size / 1024}KB`})`);
}

console.log("\nAll test objects uploaded. Starting benchmarks...\n");

// ---------------------------------------------------------------------------
// 6. Warm up both clients
// ---------------------------------------------------------------------------

await consumeBody(await s3WithNode.getObject({ Bucket, Key: TEST_OBJECTS[0].name }));
await consumeBody(await s3WithUndici.getObject({ Bucket, Key: TEST_OBJECTS[0].name }));

// ---------------------------------------------------------------------------
// 7. Benchmarks – Serial downloads (all sizes)
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – serial GetObject (all sizes)", async () => {
      for (const obj of TEST_OBJECTS) {
        const response = await s3WithNode.getObject({ Bucket, Key: obj.name });
        await consumeBody(response);
      }
    });

    bench("UndiciHttpHandler – serial GetObject (all sizes)", async () => {
      for (const obj of TEST_OBJECTS) {
        const response = await s3WithUndici.getObject({ Bucket, Key: obj.name });
        await consumeBody(response);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Benchmarks – Concurrent downloads (all sizes)
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {
    bench("NodeHttpHandler  – concurrent GetObject (all sizes)", async () => {
      const tasks = TEST_OBJECTS.map(async (obj) => {
        const response = await s3WithNode.getObject({ Bucket, Key: obj.name });
        await consumeBody(response);
      });
      await Promise.all(tasks);
    });

    bench("UndiciHttpHandler – concurrent GetObject (all sizes)", async () => {
      const tasks = TEST_OBJECTS.map(async (obj) => {
        const response = await s3WithUndici.getObject({ Bucket, Key: obj.name });
        await consumeBody(response);
      });
      await Promise.all(tasks);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Run, clean up test objects, and destroy clients
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  console.log("\nCleaning up test objects...");
  for (const obj of TEST_OBJECTS) {
    await s3WithNode.deleteObject({ Bucket, Key: obj.name }).catch(() => {});
  }
  console.log("Cleanup complete.");

  nodeHandler.destroy();
  undiciHandler.destroy();
  undiciDispatcher.destroy();
  s3WithNode.destroy();
  s3WithUndici.destroy();
}
