import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ARK_IMAGE_ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const MODEL_ID =
  process.env.ARK_IMAGE_MODEL?.trim() || "doubao-seedream-4-0-250828";
const OUTPUT_SIZE = "1K";
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function requiredArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value) {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  throw new Error(`Unsupported input image extension: ${extension || "none"}`);
}

function extensionFor(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpg";
  throw new Error(`Ark returned unsupported image content type: ${contentType}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedResponse(response, maxBytes, label) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`${label} returned an empty body`);
  }
  if (bytes.length > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${bytes.length}`);
  }
  return bytes;
}

const caseId = requiredArgument("case-id");
const inputPath = path.resolve(requiredArgument("input"));
const outputDirectory = path.resolve(requiredArgument("output-dir"));
const prompt = requiredArgument("prompt");
const apiKey =
  process.env.ARK_RUNTIME_API_KEY?.trim() || process.env.ARK_API_KEY?.trim();

if (!apiKey) {
  throw new Error("ARK_RUNTIME_API_KEY or ARK_API_KEY is not configured");
}

const inputBytes = await readFile(inputPath);
if (inputBytes.length === 0 || inputBytes.length > MAX_INPUT_BYTES) {
  throw new Error(
    `Input image must contain 1-${MAX_INPUT_BYTES} bytes; received ${inputBytes.length}`,
  );
}

await mkdir(outputDirectory, { recursive: true });

const requestStartedAt = Date.now();
const generationResponse = await fetch(ARK_IMAGE_ENDPOINT, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: MODEL_ID,
    prompt,
    image: `data:${contentTypeFor(inputPath)};base64,${inputBytes.toString("base64")}`,
    response_format: "url",
    size: OUTPUT_SIZE,
    stream: false,
    watermark: false,
  }),
  signal: AbortSignal.timeout(120_000),
});

const generationBody = await generationResponse.json();
if (!generationResponse.ok) {
  const upstreamMessage =
    generationBody?.error?.message || generationBody?.message || "unknown error";
  throw new Error(
    `Ark image generation failed with HTTP ${generationResponse.status}: ${upstreamMessage}`,
  );
}

const generatedImageUrl = generationBody?.data?.[0]?.url;
if (!generatedImageUrl) {
  throw new Error("Ark image generation response did not include data[0].url");
}

const imageResponse = await fetch(generatedImageUrl, {
  signal: AbortSignal.timeout(60_000),
});
if (!imageResponse.ok) {
  throw new Error(`Generated image download failed with HTTP ${imageResponse.status}`);
}

const outputContentType =
  imageResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ||
  "";
const outputBytes = await readBoundedResponse(
  imageResponse,
  MAX_OUTPUT_BYTES,
  "Generated image download",
);
const outputPath = path.join(
  outputDirectory,
  `${caseId}.${extensionFor(outputContentType)}`,
);
await writeFile(outputPath, outputBytes);

const receipt = {
  schemaVersion: 1,
  caseId,
  model: MODEL_ID,
  prompt,
  input: {
    path: inputPath,
    bytes: inputBytes.length,
    sha256: sha256(inputBytes),
  },
  output: {
    path: outputPath,
    contentType: outputContentType,
    bytes: outputBytes.length,
    sha256: sha256(outputBytes),
  },
  request: {
    size: OUTPUT_SIZE,
    watermark: false,
    durationMs: Date.now() - requestStartedAt,
  },
  createdAt: new Date().toISOString(),
};

const receiptPath = path.join(outputDirectory, `${caseId}.receipt.json`);
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify({
    caseId,
    model: MODEL_ID,
    outputPath,
    receiptPath,
    durationMs: receipt.request.durationMs,
  }),
);
