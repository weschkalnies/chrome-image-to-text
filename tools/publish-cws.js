#!/usr/bin/env node
/**
 * Zero-dependency Chrome Web Store API v2 publisher (Service Account / OIDC).
 *
 * Usage:
 *   node tools/publish-cws.js --mode <draft|staged|publish|status> [--zip <path>] [--dry-run]
 *
 * Environment variables:
 *   CWS_PUBLISHER_ID             Chrome Web Store Publisher ID (required)
 *   CWS_EXTENSION_ID             Chrome Web Store Extension / Item ID (required)
 *   CWS_ACCESS_TOKEN             Pre-minted OAuth2 access token (optional, e.g. WIF/OIDC)
 *   CWS_SERVICE_ACCOUNT_JSON     Raw Service Account JSON string (CI Secret)
 *   CWS_SERVICE_ACCOUNT_KEY_FILE Path to Service Account JSON key file (local CLI)
 *   GOOGLE_APPLICATION_CREDENTIALS Fallback path to Service Account JSON key file
 *   CWS_API_BASE                 Optional API base URL override (tests/mocking)
 *   CWS_POLL_INTERVAL_MS         Async upload polling interval in ms (default: 3000)
 *   CWS_POLL_TIMEOUT_MS          Async upload polling timeout in ms (default: 120000)
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_API_BASE = "https://chromewebstore.googleapis.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const CWS_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const DEFAULT_ZIP_PATH = path.resolve(__dirname, "..", "localocr-screen-to-text.zip");
const DEFAULT_ENV_FILE = path.resolve(__dirname, "..", ".env.cws");
const VALID_MODES = new Set(["draft", "staged", "publish", "status"]);

/** Loads KEY=VALUE pairs from a local .env file without overriding existing env vars. */
function loadEnvFile(filePath, targetEnv = process.env) {
  const envCopy = { ...targetEnv };
  if (!filePath || !fs.existsSync(filePath)) {
    return envCopy;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (envCopy[key] === undefined || envCopy[key] === "") {
      envCopy[key] = value;
    }
  }
  return envCopy;
}

function printHelp() {
  console.log(
    [
      "Usage: node tools/publish-cws.js [options]",
      "",
      "Options:",
      "  --mode <draft|staged|publish|status>  Action to perform (default: draft)",
      "  --zip <path>                          Path to extension ZIP (default: localocr-screen-to-text.zip)",
      "  --dry-run                             Validate config, auth JSON, and ZIP without network calls",
      "  -h, --help                            Show this help message",
    ].join("\n")
  );
}

/** Parses CLI flags into validated options. */
function parseArgs(argv) {
  const options = {
    mode: "draft",
    zipPath: DEFAULT_ZIP_PATH,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--mode") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --mode.");
      }
      options.mode = value;
      i += 1;
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--zip") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --zip.");
      }
      options.zipPath = path.resolve(value);
      i += 1;
    } else if (arg.startsWith("--zip=")) {
      options.zipPath = path.resolve(arg.slice("--zip=".length));
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!VALID_MODES.has(options.mode)) {
    throw new Error(
      `Invalid --mode "${options.mode}". Expected one of: ${Array.from(VALID_MODES).join(", ")}.`
    );
  }

  return options;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizePrivateKey(privateKey) {
  return String(privateKey).replace(/\\n/g, "\n");
}

/** Loads and validates Service Account credentials from env or key file. */
function loadServiceAccount(env = process.env) {
  let rawJson;
  let sourceLabel;

  if (env.CWS_SERVICE_ACCOUNT_JSON && env.CWS_SERVICE_ACCOUNT_JSON.trim()) {
    rawJson = env.CWS_SERVICE_ACCOUNT_JSON;
    sourceLabel = "CWS_SERVICE_ACCOUNT_JSON";
  } else {
    const keyFile =
      (env.CWS_SERVICE_ACCOUNT_KEY_FILE && env.CWS_SERVICE_ACCOUNT_KEY_FILE.trim()) ||
      (env.GOOGLE_APPLICATION_CREDENTIALS && env.GOOGLE_APPLICATION_CREDENTIALS.trim());
    if (!keyFile) {
      throw new Error(
        "Missing credentials. Set CWS_ACCESS_TOKEN, CWS_SERVICE_ACCOUNT_JSON, CWS_SERVICE_ACCOUNT_KEY_FILE, or GOOGLE_APPLICATION_CREDENTIALS."
      );
    }
    const resolvedPath = path.resolve(keyFile);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Service account key file not found: ${resolvedPath}`);
    }
    rawJson = fs.readFileSync(resolvedPath, "utf8");
    sourceLabel = resolvedPath;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid JSON in service account credentials (${sourceLabel}): ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Service account credentials (${sourceLabel}) must be a JSON object.`);
  }
  if (typeof parsed.client_email !== "string" || !parsed.client_email.trim()) {
    throw new Error(`Service account credentials (${sourceLabel}) missing client_email.`);
  }
  if (typeof parsed.private_key !== "string" || !parsed.private_key.trim()) {
    throw new Error(`Service account credentials (${sourceLabel}) missing private_key.`);
  }

  const privateKey = normalizePrivateKey(parsed.private_key);
  try {
    crypto.createPrivateKey(privateKey);
  } catch (error) {
    throw new Error(`Invalid service account private_key (${sourceLabel}): ${error.message}`);
  }

  return {
    client_email: parsed.client_email.trim(),
    private_key: privateKey,
    token_uri:
      typeof parsed.token_uri === "string" && parsed.token_uri.trim()
        ? parsed.token_uri.trim()
        : DEFAULT_TOKEN_URI,
  };
}

/** Creates an RS256-signed JWT assertion for Google OAuth2 Service Account exchange. */
function createServiceAccountJwt(
  serviceAccount,
  scope = CWS_SCOPE,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
      aud: serviceAccount.token_uri || DEFAULT_TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(normalizePrivateKey(serviceAccount.private_key)));
  return `${signingInput}.${signature}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data ? JSON.stringify(data) : text.slice(0, 1000);
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from ${url}${detail ? ": " + detail : ""}`
    );
  }
  return data || {};
}

/** Obtains an OAuth2 access token from CWS_ACCESS_TOKEN or a Service Account JWT exchange. */
async function getAccessToken(env = process.env) {
  if (env.CWS_ACCESS_TOKEN && env.CWS_ACCESS_TOKEN.trim()) {
    return env.CWS_ACCESS_TOKEN.trim();
  }

  const serviceAccount = loadServiceAccount(env);
  const assertion = createServiceAccountJwt(serviceAccount, CWS_SCOPE);
  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();

  const tokenResponse = await requestJson(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!tokenResponse || typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) {
    throw new Error("OAuth2 token endpoint did not return an access_token.");
  }
  return tokenResponse.access_token;
}

function itemPath(publisherId, itemId) {
  return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
}

async function fetchItemStatus({ apiBase, publisherId, itemId, accessToken }) {
  const url = `${apiBase}/v2/${itemPath(publisherId, itemId)}:fetchStatus`;
  return requestJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

function assertZipFile(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Extension ZIP not found: ${zipPath}`);
  }
  const stat = fs.statSync(zipPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Extension ZIP is empty or not a regular file: ${zipPath}`);
  }
  return stat.size;
}

async function uploadPackage({ apiBase, publisherId, itemId, accessToken, zipPath }) {
  assertZipFile(zipPath);
  const zipBuffer = fs.readFileSync(zipPath);
  const url = `${apiBase}/upload/v2/${itemPath(publisherId, itemId)}:upload`;
  return requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/zip",
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-File-Name": path.basename(zipPath),
    },
    body: zipBuffer,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUpload({
  apiBase,
  publisherId,
  itemId,
  accessToken,
  initialResponse,
  pollIntervalMs = 3000,
  pollTimeoutMs = 120000,
}) {
  const state = initialResponse && initialResponse.uploadState;
  if (state === "SUCCEEDED") {
    return { uploadState: "SUCCEEDED", response: initialResponse };
  }
  if (state === "FAILED") {
    throw new Error("Package upload failed: " + JSON.stringify(initialResponse));
  }
  if (state !== "IN_PROGRESS") {
    throw new Error(
      `Unexpected uploadState "${state || "missing"}": ${JSON.stringify(initialResponse)}`
    );
  }

  const deadline = Date.now() + pollTimeoutMs;
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for async upload after ${pollTimeoutMs} ms.`);
    }
    await sleep(pollIntervalMs);
    const status = await fetchItemStatus({ apiBase, publisherId, itemId, accessToken });
    const asyncState = status && status.lastAsyncUploadState;
    if (asyncState === "SUCCEEDED") {
      return { uploadState: "SUCCEEDED", status };
    }
    if (asyncState === "FAILED" || asyncState === "NOT_FOUND") {
      throw new Error(
        `Async upload did not succeed (${asyncState}): ${JSON.stringify(status)}`
      );
    }
  }
}

async function publishItem({ apiBase, publisherId, itemId, accessToken, publishType }) {
  const url = `${apiBase}/v2/${itemPath(publisherId, itemId)}:publish`;
  return requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ publishType }),
  });
}

/** Validates config/ZIP and executes the requested Chrome Web Store API v2 action. */
async function run(options, env = process.env) {
  const publisherId = (env.CWS_PUBLISHER_ID || "").trim();
  const itemId = (env.CWS_EXTENSION_ID || "").trim();
  if (!publisherId) {
    throw new Error("Missing CWS_PUBLISHER_ID environment variable.");
  }
  if (!itemId) {
    throw new Error("Missing CWS_EXTENSION_ID environment variable.");
  }

  const apiBase = (env.CWS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const pollIntervalMs = Number(env.CWS_POLL_INTERVAL_MS || 3000);
  const pollTimeoutMs = Number(env.CWS_POLL_TIMEOUT_MS || 120000);

  let zipSize = null;
  if (options.mode !== "status") {
    zipSize = assertZipFile(options.zipPath);
  }

  if (options.dryRun) {
    if (!env.CWS_ACCESS_TOKEN || !env.CWS_ACCESS_TOKEN.trim()) {
      loadServiceAccount(env);
    }
    console.log(
      `[CWS dry-run] OK: mode=${options.mode}, publisherId=${publisherId}, itemId=${itemId}` +
        (zipSize !== null ? `, zip=${options.zipPath} (${zipSize} bytes)` : "")
    );
    return {
      dryRun: true,
      mode: options.mode,
      publisherId,
      itemId,
      zipPath: options.zipPath,
    };
  }

  const accessToken = await getAccessToken(env);

  if (options.mode === "status") {
    const status = await fetchItemStatus({ apiBase, publisherId, itemId, accessToken });
    console.log(JSON.stringify(status, null, 2));
    return { mode: "status", status };
  }

  console.log(`[CWS] Uploading ${path.basename(options.zipPath)} (${zipSize} bytes)...`);
  const uploadResponse = await uploadPackage({
    apiBase,
    publisherId,
    itemId,
    accessToken,
    zipPath: options.zipPath,
  });
  const uploadResult = await waitForUpload({
    apiBase,
    publisherId,
    itemId,
    accessToken,
    initialResponse: uploadResponse,
    pollIntervalMs,
    pollTimeoutMs,
  });

  if (options.mode === "draft") {
    console.log("[CWS] Draft upload succeeded (not submitted for review).");
    return { mode: "draft", uploadResult };
  }

  const publishType = options.mode === "staged" ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH";
  console.log(`[CWS] Submitting item with publishType=${publishType}...`);
  const publishResult = await publishItem({
    apiBase,
    publisherId,
    itemId,
    accessToken,
    publishType,
  });
  console.log(`[CWS] Publish request accepted (${publishType}).`);
  return { mode: options.mode, uploadResult, publishResult };
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const env = loadEnvFile(DEFAULT_ENV_FILE, process.env);
    await run(options, env);
  })().catch((error) => {
    console.error("[CWS] ERROR:", error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  CWS_SCOPE,
  parseArgs,
  loadEnvFile,
  loadServiceAccount,
  createServiceAccountJwt,
  getAccessToken,
  fetchItemStatus,
  uploadPackage,
  waitForUpload,
  publishItem,
  run,
};
