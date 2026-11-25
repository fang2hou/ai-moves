# AWS runtime adapter

Implements the runtime ports from `@ai-moves/contracts/ports` on AWS: S3 for blobs, SQS for the job bus, and SSM Parameter Store for secrets, plus the Lambda event decoders. It is the AWS counterpart of [`runtime-cloudflare`](../runtime-cloudflare) (see [docs/portability.md](../../docs/portability.md)).

| Import                               | Provides                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/runtime-aws/sigv4`        | `signRequest`: Signature Version 4 over Web Crypto, and `sha256Hex`                                                                                                                             |
| `@ai-moves/runtime-aws/json-client`  | `createAwsJsonClient`: one signed call to an AWS JSON-protocol API; the DynamoDB, SQS, and SSM protocol descriptors                                                                             |
| `@ai-moves/runtime-aws/environment`  | `readAwsEnvironment`: region, execution-role credentials, and `AWS_ENDPOINT_URL[_<SERVICE>]` overrides (`BEDROCK_MANTLE`, `BEDROCK_RUNTIME`, `DYNAMODB`, `S3`, `SQS`, `SSM`) from an env record |
| `@ai-moves/runtime-aws/blob-store`   | `createS3BlobStore`: the content-addressed `BlobStore`                                                                                                                                          |
| `@ai-moves/runtime-aws/queue`        | `createSqsJobBus`: the `JobBus`, routing each job to its queue URL                                                                                                                              |
| `@ai-moves/runtime-aws/secrets`      | `createSsmSecretProvider`: SecureString parameters under a path prefix, cached per runtime instance                                                                                             |
| `@ai-moves/runtime-aws/signed-fetch` | `createSignedFetch`: a `fetch` that signs every request for one service, for adapters that speak a provider's own HTTP API                                                                      |
| `@ai-moves/runtime-aws/lambda`       | `readSqsEvent`, `decodeSqsJob`, `decodeScheduledEvent`, and the partial-batch response type                                                                                                     |

- The repository bans provider SDKs, `@aws-sdk/*` included, so every call is a `fetch` signed by `sigv4.ts`. The package receives `fetch`, the clock, and credentials by injection and never reads `process.env`; the composition root passes the environment to `readAwsEnvironment`.
- The signer was checked against botocore for DynamoDB, SQS, SSM, an S3 `PUT`, an S3 `GET` with a query string, and a non-S3 path that needs double encoding, all with a session token. S3 signs the path as sent; every other service signs each segment encoded once more.
- `createAwsJsonClient` makes one request and never retries. A transport failure rejects with `UPSTREAM_UNAVAILABLE`; every answered request resolves with `ok`, the HTTP status, and the exception name, so the adapter that called it decides what the error means.
- The job bus validates every job before sending, sends at most ten messages per `SendMessageBatch`, and treats a partial `Failed` list as `QUEUE_UNAVAILABLE`. Delays stay within the portable 900-second limit, which is also the SQS maximum.
- `has` and `put` rely on S3 answering `404` for a missing object, which it does only when the caller may `s3:ListBucket` the bucket; without it S3 answers `403` and the store reports `STORAGE_UNAVAILABLE`.
- A missing parameter is `SECRET_MISSING`. Values are cached for the time the caller sets, so a rotated secret takes effect within that window or on a new runtime instance.
