"use strict";

const path = require("path");
const { DesktopHostProcess } = require("../electron/host-process");

const PROBE_CWD = path.resolve(__dirname, "..");

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(`Assertion failed: ${label}`);
}

async function run() {
  console.log("Running Framed Byte Stream pipeline tests...");

  const pkgDir = path.resolve(__dirname, "../runtime-seed/node_modules/@agegr/pi-web");
  const bridgeScript = path.resolve(__dirname, "../electron/host-bridge.js");

  const host = new DesktopHostProcess(process.execPath, bridgeScript, pkgDir, {
    dbg: (msg) => console.log(`[DEBUG] ${msg}`),
  });

  await host.start();
  console.log("Host is READY.\n");

  // --- Concurrent GETs -----------------------------------------------------
  const urls = ["http://localhost/", "http://localhost/", "http://localhost/favicon.ico"];
  const startTime = Date.now();
  const responses = await Promise.all(
    urls.map((url) => host.fetch(new Request(url, { method: "GET" })))
  );
  console.log(`3 concurrent GETs completed in ${Date.now() - startTime}ms`);
  for (let i = 0; i < responses.length; i++) {
    const res = responses[i];
    const text = await res.text();
    check(`GET ${urls[i]}`, res.status === 200 || res.status === 404, `status=${res.status}, len=${text.length}`);
  }

  // --- POST with a body ----------------------------------------------------
  // The request body must reach the route AND the socket must stay open long
  // enough for the response to come back (regression: half-close killed it).
  async function postValidate(extraHeaders, pad) {
    const payload = { cwd: PROBE_CWD };
    if (pad) payload.pad = "x".repeat(pad);
    const body = JSON.stringify(payload);
    const headers = Object.assign({ "content-type": "application/json" }, extraHeaders || {});
    const res = await host.fetch(
      new Request("http://localhost/api/cwd/validate", { method: "POST", headers, body })
    );
    return { status: res.status, json: JSON.parse(await res.text()) };
  }

  const chunked = await postValidate();
  check("POST body (chunked, no content-length)", chunked.status === 200 && chunked.json.success === true, `status=${chunked.status}`);

  const fixedBody = JSON.stringify({ cwd: PROBE_CWD });
  const fixed = await postValidate({ "content-length": String(Buffer.byteLength(fixedBody)) });
  check("POST body (explicit content-length)", fixed.status === 200 && fixed.json.success === true, `status=${fixed.status}`);

  const large = await postValidate(null, 300 * 1024);
  check("POST body (300 KB, multi-frame)", large.status === 200 && large.json.success === true, `status=${large.status}`);

  // --- HEAD ----------------------------------------------------------------
  const head = await host.fetch(new Request("http://localhost/", { method: "HEAD" }));
  check("HEAD completes without hanging", head.status === 200, `status=${head.status}`);

  // --- Mixed concurrency ---------------------------------------------------
  const mixed = await Promise.all([
    host.fetch(new Request("http://localhost/", { method: "GET" })),
    postValidate().then((r) => ({ status: r.status })),
    host.fetch(new Request("http://localhost/api/home", { method: "GET" })),
    postValidate().then((r) => ({ status: r.status })),
  ]);
  check("mixed GET/POST concurrency", mixed.every((r) => r.status === 200), mixed.map((r) => r.status).join(","));

  console.log("\n>>> ALL FRAMED PIPELINE TESTS PASSED! <<<");
  await host.stop();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
