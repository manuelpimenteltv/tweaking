import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

/** Ensures the test bucket exists (MinIO/S3 must be running; see docs/DEVELOPMENT.md). */
export async function execSetupStorage() {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET! }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET! }));
  }
}
