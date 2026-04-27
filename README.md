# @trivikr-test/undici-http-handler

Test Http Handler which use Node.js undici instead of NodeHttpHandler

## Usage

Use UndiciHttpHandler as drop-in replacement for NodeHttpHandler from
@smithy/node-http-handler, by passing it in requestHandler configuration of client.

Example

```js
import { S3 } from "@aws-sdk/client-s3";
import { UndiciHttpHandler } from "@trivikr-test/undici-http-handler";

const client = new S3({
  requestHandler: new UndiciHttpHandler(),
});

client.listBuckets().then(console.log);
```
