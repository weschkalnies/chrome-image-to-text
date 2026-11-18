/**
 * Unit and mock-server regression test for tools/publish-cws.js.
 *
 * Verifies without real Google credentials or network calls:
 * - RS256 Service Account JWT signing and payload claims;
 * - OAuth2 JWT bearer token exchange;
 * - draft upload (raw binary ZIP, no :publish call);
 * - publish with async IN_PROGRESS -> SUCCEEDED polling;
 * - staged publish (STAGED_PUBLISH);
 * - status fetch (:fetchStatus only);
 * - failure propagation (FAILED uploadState and HTTP 403 without secret leaks);
 * - --dry-run (zero HTTP requests).
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const {
  CWS_SCOPE,
  parseArgs,
  loadEnvFile,
  createServiceAccountJwt,
  run,
} = require("../tools/publish-cws.js");

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (segment.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startMockServer() {
  const state = {
    requests: [],
    uploadResponse: { uploadState: "SUCCEEDED", itemId: "ext-123" },
    statusQueue: [],
    defaultStatus: { itemId: "ext-123", lastAsyncUploadState: "SUCCEEDED" },
    publishStatusCode: 200,
    publishResponse: { state: "PENDING_REVIEW" },
  };

  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    state.requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.method === "POST" && req.url === "/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-access-token", expires_in: 3600, token_type: "Bearer" }));
      return;
    }

    if (req.method === "POST" && req.url === "/upload/v2/publishers/pub-999/items/ext-123:upload") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.uploadResponse));
      return;
    }

    if (req.method === "GET" && req.url === "/v2/publishers/pub-999/items/ext-123:fetchStatus") {
      const next = state.statusQueue.length > 0 ? state.statusQueue.shift() : state.defaultStatus;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next));
      return;
    }

    if (req.method === "POST" && req.url === "/v2/publishers/pub-999/items/ext-123:publish") {
      res.writeHead(state.publishStatusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.publishResponse));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        reset(overrides = {}) {
          state.requests = [];
          state.uploadResponse = { uploadState: "SUCCEEDED", itemId: "ext-123" };
          state.statusQueue = [];
          state.defaultStatus = { itemId: "ext-123", lastAsyncUploadState: "SUCCEEDED" };
          state.publishStatusCode = 200;
          state.publishResponse = { state: "PENDING_REVIEW" };
          Object.assign(state, overrides);
        },
      });
    });
  });
}

(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cws-publish-test-"));
  const zipPath = path.join(tmpDir, "test-ext.zip");
  const zipBytes = Buffer.from("PK\x03\x04mock-zip-payload-12345");
  fs.writeFileSync(zipPath, zipBytes);

  const mock = await startMockServer();

  try {
    const serviceAccount = {
      client_email: "cws-ci@example-project.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: `${mock.baseUrl}/token`,
    };

    // 1. RS256 JWT structure and signature verification
    const now = 1700000000;
    const jwt = createServiceAccountJwt(serviceAccount, CWS_SCOPE, now);
    const parts = jwt.split(".");
    assert.strictEqual(parts.length, 3, "JWT must have 3 segments");
    const header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
    assert.deepStrictEqual(header, { alg: "RS256", typ: "JWT" });
    assert.strictEqual(payload.iss, serviceAccount.client_email);
    assert.strictEqual(payload.scope, CWS_SCOPE);
    assert.strictEqual(payload.aud, serviceAccount.token_uri);
    assert.strictEqual(payload.iat, now);
    assert.strictEqual(payload.exp - payload.iat, 3600);

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    assert.strictEqual(
      verifier.verify(publicKey, base64UrlDecode(parts[2])),
      true,
      "JWT RS256 signature must verify against public key"
    );

    const baseEnv = {
      CWS_PUBLISHER_ID: "pub-999",
      CWS_EXTENSION_ID: "ext-123",
      CWS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
      CWS_API_BASE: mock.baseUrl,
      CWS_POLL_INTERVAL_MS: "10",
      CWS_POLL_TIMEOUT_MS: "1000",
    };

    // 2. Draft upload (immediate SUCCEEDED, no :publish call)
    mock.reset();
    const draftRes = await run(parseArgs(["--mode", "draft", "--zip", zipPath]), baseEnv);
    assert.strictEqual(draftRes.mode, "draft");
    assert.strictEqual(mock.state.requests.length, 2, "Expected token + upload requests");
    const tokenReq = mock.state.requests[0];
    assert.strictEqual(tokenReq.url, "/token");
    assert(tokenReq.body.toString("utf8").includes("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"));
    const uploadReq = mock.state.requests[1];
    assert.strictEqual(uploadReq.headers.authorization, "Bearer mock-access-token");
    assert.strictEqual(uploadReq.headers["x-goog-upload-protocol"], "raw");
    assert.strictEqual(uploadReq.headers["x-goog-upload-file-name"], "test-ext.zip");
    assert.strictEqual(Buffer.compare(uploadReq.body, zipBytes), 0, "Uploaded ZIP bytes must match disk file");

    // 3. Publish with IN_PROGRESS polling -> DEFAULT_PUBLISH
    mock.reset({
      uploadResponse: { uploadState: "IN_PROGRESS", itemId: "ext-123" },
      statusQueue: [
        { itemId: "ext-123", lastAsyncUploadState: "IN_PROGRESS" },
        { itemId: "ext-123", lastAsyncUploadState: "SUCCEEDED" },
      ],
    });
    const publishRes = await run(parseArgs(["--mode=publish", `--zip=${zipPath}`]), baseEnv);
    assert.strictEqual(publishRes.mode, "publish");
    assert.deepStrictEqual(
      mock.state.requests.map((r) => r.url),
      [
        "/token",
        "/upload/v2/publishers/pub-999/items/ext-123:upload",
        "/v2/publishers/pub-999/items/ext-123:fetchStatus",
        "/v2/publishers/pub-999/items/ext-123:fetchStatus",
        "/v2/publishers/pub-999/items/ext-123:publish",
      ]
    );
    const publishBody = JSON.parse(mock.state.requests[4].body.toString("utf8"));
    assert.deepStrictEqual(publishBody, { publishType: "DEFAULT_PUBLISH" });

    // 4. Staged publish -> STAGED_PUBLISH
    mock.reset();
    await run(parseArgs(["--mode", "staged", "--zip", zipPath]), baseEnv);
    const stagedReq = mock.state.requests.find((r) => r.url.endsWith(":publish"));
    assert(stagedReq, "Expected :publish request for staged mode");
    assert.deepStrictEqual(JSON.parse(stagedReq.body.toString("utf8")), { publishType: "STAGED_PUBLISH" });

    // 5. Status mode -> only :fetchStatus (no upload/publish)
    mock.reset();
    const statusRes = await run(parseArgs(["--mode", "status"]), baseEnv);
    assert.strictEqual(statusRes.status.itemId, "ext-123");
    assert.deepStrictEqual(
      mock.state.requests.map((r) => r.url),
      ["/token", "/v2/publishers/pub-999/items/ext-123:fetchStatus"]
    );

    // 6. FAILED uploadState does not trigger :publish and never leaks private key
    mock.reset({ uploadResponse: { uploadState: "FAILED", itemId: "ext-123" } });
    await assert.rejects(
      () => run(parseArgs(["--mode", "publish", "--zip", zipPath]), baseEnv),
      (err) => {
        assert(err.message.includes("Package upload failed"));
        assert(!err.message.includes("BEGIN PRIVATE KEY"));
        assert(!err.message.includes("mock-access-token"));
        return true;
      }
    );
    assert.strictEqual(
      mock.state.requests.some((r) => r.url.endsWith(":publish")),
      false,
      ":publish must not run after FAILED upload"
    );

    // 7. HTTP 403 on publish rejects cleanly without leaking credentials
    mock.reset({
      publishStatusCode: 403,
      publishResponse: { error: { code: 403, message: "Forbidden" } },
    });
    await assert.rejects(
      () => run(parseArgs(["--mode", "publish", "--zip", zipPath]), baseEnv),
      (err) => {
        assert(err.message.includes("403"));
        assert(!err.message.includes("BEGIN PRIVATE KEY"));
        assert(!err.message.includes("mock-access-token"));
        return true;
      }
    );

    // 8. --dry-run validates without making any HTTP requests
    mock.reset();
    const dryRes = await run(parseArgs(["--mode", "publish", "--zip", zipPath, "--dry-run"]), baseEnv);
    assert.strictEqual(dryRes.dryRun, true);
    assert.strictEqual(mock.state.requests.length, 0, "--dry-run must make zero HTTP requests");

    // 9. loadEnvFile parses comments/quotes and preserves explicit env vars
    const envFilePath = path.join(tmpDir, ".env.cws");
    fs.writeFileSync(
      envFilePath,
      [
        "# Kommentar",
        "",
        "CWS_PUBLISHER_ID=\"pub-from-file\"",
        "CWS_EXTENSION_ID='ext-from-file'",
        "CWS_SERVICE_ACCOUNT_KEY_FILE=/tmp/cws-key.json",
      ].join("\n"),
      "utf8"
    );
    const loadedEnv = loadEnvFile(envFilePath, { CWS_PUBLISHER_ID: "pub-explicit", CWS_EXTENSION_ID: "" });
    assert.strictEqual(loadedEnv.CWS_PUBLISHER_ID, "pub-explicit", "Existing shell env var must take precedence");
    assert.strictEqual(loadedEnv.CWS_EXTENSION_ID, "ext-from-file", "Empty env var should be populated from file");
    assert.strictEqual(loadedEnv.CWS_SERVICE_ACCOUNT_KEY_FILE, "/tmp/cws-key.json");
    const missingEnv = loadEnvFile(path.join(tmpDir, "does-not-exist"), { FOO: "bar" });
    assert.deepStrictEqual(missingEnv, { FOO: "bar" });

    console.log("OK: Chrome Web Store API v2 publisher (JWT, upload polling, publish, dry-run, .env.cws) verified.");
  } finally {
    await new Promise((resolve) => mock.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("TEST FEHLER:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
