"use strict";

const path = require("path");
const { DesktopHostProcess } = require("../electron/host-process");

async function run() {
  console.log("Running Multi-Request & Concurrency Tests over Framed Byte Stream...");

  const pkgDir = path.resolve(__dirname, "../runtime-seed/node_modules/@agegr/pi-web");
  const bridgeScript = path.resolve(__dirname, "../electron/host-bridge.js");

  const host = new DesktopHostProcess(process.execPath, bridgeScript, pkgDir, {
    dbg: (msg) => console.log(`[DEBUG] ${msg}`),
  });

  await host.start();
  console.log("Host is READY. Testing concurrent requests...");

  const urls = [
    "http://localhost/",
    "http://localhost/",
    "http://localhost/favicon.ico",
  ];

  const startTime = Date.now();
  const responses = await Promise.all(
    urls.map((url, idx) => {
      console.log(`Sending concurrent request #${idx + 1}: ${url}`);
      return host.fetch(new Request(url, { method: "GET" }));
    })
  );

  console.log(`\nAll 3 concurrent requests completed in ${Date.now() - startTime}ms`);

  for (let i = 0; i < responses.length; i++) {
    const res = responses[i];
    const text = await res.text();
    console.log(`Response #${i + 1}: status=${res.status}, bodyLength=${text.length}`);
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`Unexpected status code: ${res.status}`);
    }
  }

  console.log("\n>>> ALL MULTI-REQUEST TESTS PASSED! <<<");
  await host.stop();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
