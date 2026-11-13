const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
const uploadDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
const s3Config = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION || 'auto',
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
};
const requiredS3Settings = [s3Config.endpoint, s3Config.bucket, s3Config.accessKeyId, s3Config.secretAccessKey];
const configuredS3 = requiredS3Settings.every(Boolean);
const partiallyConfiguredS3 = requiredS3Settings.some(Boolean) && !configuredS3;
let s3;

function initialize() {
  if (partiallyConfiguredS3) throw new Error('Configure S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY together.');
  if (isProduction && !configuredS3) throw new Error('Configure private S3-compatible object storage before running in production.');
  if (configuredS3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      forcePathStyle: Boolean(process.env.S3_FORCE_PATH_STYLE === 'true'),
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      }
    });
  } else {
    return fs.mkdir(uploadDirectory, { recursive: true });
  }
}

function extensionFor(mimeType) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mimeType];
}

function safeObjectKey(key) {
  if (typeof key !== 'string' || key === '.' || key === '..' || path.basename(key) !== key ||
      !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/.test(key)) {
    throw new Error('Invalid screenshot object key.');
  }
  return key;
}

async function saveScreenshot(file, objectKey) {
  const extension = extensionFor(file.mimetype);
  if (!extension) throw new Error('Unsupported screenshot type.');
  const key = safeObjectKey(objectKey || `${crypto.randomUUID()}.${extension}`);
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: file.buffer,
      ContentLength: file.size,
      ContentType: file.mimetype,
      CacheControl: 'private, no-store'
    }));
  } else {
    await fs.writeFile(path.join(uploadDirectory, key), file.buffer, { flag: 'wx' });
  }
  return key;
}

async function readScreenshot(key) {
  if (s3) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const result = await s3.send(new GetObjectCommand({ Bucket: s3Config.bucket, Key: safeObjectKey(key) }));
    return {
      body: Buffer.from(await result.Body.transformToByteArray()),
      contentType: result.ContentType || 'application/octet-stream'
    };
  }
  const safeKey = safeObjectKey(key);
  const body = await fs.readFile(path.join(uploadDirectory, safeKey));
  const extension = path.extname(safeKey).toLowerCase();
  return {
    body,
    contentType: ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[extension] || 'application/octet-stream'
  };
}

async function deleteScreenshot(key) {
  if (!key) return;
  if (s3) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: safeObjectKey(key) }));
    return;
  }
  await fs.unlink(path.join(uploadDirectory, safeObjectKey(key))).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

module.exports = {
  initialize,
  saveScreenshot,
  readScreenshot,
  deleteScreenshot
};
