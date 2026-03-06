#!/usr/bin/env node

/**
 * Helper script to get Dida365 OAuth access token.
 *
 * Usage:
 *   node scripts/get-token.js <client_id> <client_secret>
 *
 * Steps:
 * 1. Register app at https://developer.dida365.com/manage
 * 2. Set redirect URI to: http://localhost:3000/callback
 * 3. Run this script with your client_id and client_secret
 * 4. Open the URL printed in browser, authorize the app
 * 5. Copy the access token from the output
 */

import http from "node:http";

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-token.js <client_id> <client_secret>");
  console.error("\nGet credentials at: https://developer.dida365.com/manage");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3000/callback";
const AUTH_URL = `https://dida365.com/oauth/authorize?scope=tasks:read%20tasks:write&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=claude-skills`;

console.log("\n1. Open this URL in your browser:\n");
console.log(`   ${AUTH_URL}\n`);
console.log("2. Authorize the app, then wait for the token...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No code in callback");
    return;
  }

  try {
    const tokenRes = await fetch("https://dida365.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();

    if (data.access_token) {
      console.log("Access Token:\n");
      console.log(`   ${data.access_token}\n`);
      console.log("Add to your MCP config:");
      console.log(`   "DIDA365_ACCESS_TOKEN": "${data.access_token}"\n`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Token obtained! Check your terminal. You can close this tab.</h2>");
    } else {
      console.error("Token exchange failed:", data);
      res.writeHead(500);
      res.end("Token exchange failed: " + JSON.stringify(data));
    }
  } catch (err) {
    console.error("Error:", err.message);
    res.writeHead(500);
    res.end("Error: " + err.message);
  }

  server.close();
});

server.listen(3000, () => {
  console.log("Waiting for OAuth callback on http://localhost:3000 ...\n");
});
