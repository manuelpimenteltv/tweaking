/**
 * Creates the platform bucket (if missing) and applies the CORS rules browsers
 * need for direct multipart uploads (PUT + exposed ETag). Idempotent.
 *   pnpm storage:setup
 */
import "dotenv/config";
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

async function main() {
  const bucket = process.env.S3_BUCKET!;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "auto",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket ${bucket}`);
  }
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [new URL(appUrl).origin],
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "x-amz-checksum-sha256"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log("Applied CORS rules");
  } catch (err) {
    // MinIO configures CORS server-wide (MINIO_API_CORS_ALLOW_ORIGIN) rather than per bucket.
    console.warn(`Bucket CORS not applied (${(err as Error).name}). Configure CORS on the provider if browsers can't upload.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
