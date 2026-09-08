import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import sharp from "sharp";

// Local checks only: no provider requests, key values, or signed URLs in output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "output/logo-quality-api-test-2026-09-06/manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

let fileEnv = {};
if (await exists(resolve(root, ".env.local"))) {
  fileEnv = parseEnv(await readFile(resolve(root, ".env.local"), "utf8"));
}
const configured = (key) => Boolean((process.env[key] ?? fileEnv[key])?.trim());
const paired = (pairs) => pairs.some(([id, secret]) => configured(id) && configured(secret));

const inputs = await Promise.all(manifest.inputs.map(async (expected) => {
  try {
    const bytes = await readFile(resolve(root, expected.path));
    const { width, height } = await sharp(bytes).metadata();
    const sha256 = digest(bytes);
    return {
      id: expected.id,
      path: expected.path,
      width,
      height,
      sha256,
      passed: sha256 === expected.sha256 && width === expected.width && height === expected.height,
    };
  } catch (error) {
    return { id: expected.id, path: expected.path, passed: false, error: error.code ?? "image_read_failed" };
  }
}));
const cachedArtifacts = await Promise.all(manifest.cachedArtifacts.map(async (path) => ({
  path,
  exists: await exists(resolve(root, path)),
})));
const credentials = {
  mediaKit: { environmentConfigured: configured("MEDIAKIT_API_KEY") },
  imagex: {
    environmentConfigured: paired([
      ["VEIMAGEX_ACCESS_KEY_ID", "VEIMAGEX_SECRET_ACCESS_KEY"],
      ["VOLCENGINE_ACCESS_KEY", "VOLCENGINE_SECRET_KEY"],
      ["VOLCENGINE_ACCESS_KEY_ID", "VOLCENGINE_SECRET_ACCESS_KEY"],
    ]),
    serviceId: manifest.imagexService.id,
    liveServiceStatusVerified: false,
    resultDownloadVerified: false,
  },
  meitu: { environmentConfigured: paired([["MEITU_OPENAPI_ACCESS_KEY", "MEITU_OPENAPI_SECRET_KEY"]]) },
  vectorizer: { environmentConfigured: paired([["VECTORIZER_API_ID", "VECTORIZER_API_SECRET"]]) },
};
const integrityPassed = inputs.every((input) => input.passed);
const result = {
  checkedAt: new Date().toISOString(),
  mode: "local_only_no_provider_requests",
  manifestSha256: digest(manifestBytes),
  integrityPassed,
  cachedArtifacts,
  credentials,
  inputs,
  readyForLiveTests: false,
  requiresLiveVerification: ["service approval and download", "API permission and credential validity", "current prices and available credits"],
  missingEnvironmentConfiguration: Object.entries(credentials)
    .filter(([, entry]) => !entry.environmentConfigured)
    .map(([provider]) => provider),
  note: "Environment presence does not prove API access. Credentials stored through other approved mechanisms need separate verification. Missing provider configuration blocks only that route.",
  newPaidRequests: 0,
  budgetCny: manifest.budgetCny,
};
const destination = resolve(root, manifest.resultDirectory, "preflight.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  integrityPassed,
  inputsChecked: inputs.length,
  missingCachedArtifacts: cachedArtifacts.filter((item) => !item.exists).map((item) => item.path),
  missingEnvironmentConfiguration: result.missingEnvironmentConfiguration,
  liveVerificationRequired: true,
  newPaidRequests: 0,
  report: destination,
}, null, 2));
if (!integrityPassed) process.exitCode = 1;
