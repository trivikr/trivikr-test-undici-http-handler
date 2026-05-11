import { randomBytes, randomUUID } from "node:crypto";

import { S3 } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UndiciHttpHandler } from "./undici-http-handler";

describe("UndiciHttpHandler S3 e2e", () => {
  const bucketName = `test-undici-http-handler-${randomUUID()}`;
  const client = new S3({ requestHandler: new UndiciHttpHandler() });

  beforeAll(async () => {
    await client.createBucket({ Bucket: bucketName });
    await client.waitUntilBucketExists({ Bucket: bucketName }, { maxWaitTime: 60 });
  });

  afterAll(async () => {
    // Empty the bucket in case of test failure
    const { Contents } = await client.listObjectsV2({ Bucket: bucketName });
    if (Contents) {
      for (const { Key } of Contents) {
        await client.deleteObject({ Bucket: bucketName, Key });
      }
    }

    // Delete the bucket
    await client.deleteBucket({ Bucket: bucketName });

    client.destroy();
  });

  it("head/put/get/delete", async () => {
    const key = "test-object";
    const body = randomBytes(16 * 1024); // 16 KB of random data

    // headObject should fail before put
    await expect(
      client.headObject({ Bucket: bucketName, Key: key })
    ).rejects.toThrow();

    // Put the object
    const putResponse = await client.putObject({
      Bucket: bucketName,
      Key: key,
      Body: body,
    });
    expect(putResponse.$metadata.httpStatusCode).toBe(200);

    // headObject should succeed after put
    const headResponse = await client.headObject({
      Bucket: bucketName,
      Key: key,
    });
    expect(headResponse.$metadata.httpStatusCode).toBe(200);

    // Get the object
    const getResponse = await client.getObject({
      Bucket: bucketName,
      Key: key,
    });
    expect(getResponse.$metadata.httpStatusCode).toBe(200);

    const receivedBody = await getResponse.Body!.transformToByteArray();
    expect(Buffer.from(receivedBody)).toEqual(body);

    // Delete the object
    const deleteResponse = await client.deleteObject({
      Bucket: bucketName,
      Key: key,
    });
    expect(deleteResponse.$metadata.httpStatusCode).toBe(204);

    // headObject should fail after delete
    await expect(
      client.headObject({ Bucket: bucketName, Key: key })
    ).rejects.toThrow();
  });
});
