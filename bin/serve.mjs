#!/usr/bin/env node

// dev server
import fs from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import compression from "compression";
import cors from "cors";
import express from "express";
import expressUrlrewrite from "express-urlrewrite";
import tcpPortUsed from "tcp-port-used";

// get details for the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// create an express application
const app = express();

// define an ip address
const ipAddr = "127.0.0.1";

// define a port
let port = Number(argv[2]) || 8888;

if (port < 1024 || port > 65535) {
  console.error("Port must be between 1024 and 65535.");

  exit(1);
}

// enable CORS
const CORS_CONFIG = {
  allowPrivateIPs: false, // Enables 127.*, 10.*, 172.16-31.*, 192.168.*
  allowAllOrigins: false, // True = "*" (no credentials support)
  allowLocalhostOnly: true, // Restricts to localhost only
};

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (no Origin header)
      if (!origin) {
        return callback(null, true);
      }

      // Flag: All origins (*)
      if (CORS_CONFIG.allowAllOrigins) {
        return callback(null, true);
      }

      // Flag: Localhost only
      if (CORS_CONFIG.allowLocalhostOnly) {
        const hostname = new URL(origin).hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          return callback(null, true);
        }

        return callback(new Error("Localhost only"));
      }

      // Flag: Private IP ranges
      if (CORS_CONFIG.allowPrivateIPs) {
        try {
          const url = new URL(origin);
          const ip = url.hostname;

          // Fixed single-line regex for private IPs
          const privateIPRegex =
            /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

          if (privateIPRegex.test(ip)) {
            return callback(null, true);
          }
        } catch {
          // Invalid URL, skip
        }
      }

      // Reject other origins
      return callback(new Error("Not allowed by CORS"));
    },
  }),
);

// enable compression
app.use(compression());

// parse JSON bodies (increased limit for large proxy payloads)
app.use(express.json({ limit: "250mb" }));

// ---------------- PROXY ENDPOINT ----------------
// Example usages:
//   GET  /proxy?url=https://example.com
//   POST /proxy  with JSON { "url": "https://example.com", "method": "GET", "headers": {...}, "body": "..." }
app.all("/proxy", async (req, res) => {
  try {
    // You can pass url either as query param or in JSON body
    const urlFromQuery =
      typeof req.query.url === "string" ? req.query.url : undefined;
    const urlFromBody =
      req.body && typeof req.body.url === "string" ? req.body.url : undefined;

    const target = urlFromBody || urlFromQuery;

    if (!target) {
      res.status(400).json({ error: "Missing 'url' parameter" });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      res.status(400).json({ error: "Invalid URL" });
      return;
    }

    // Optional safety: restrict which hosts can be proxied
    // const allowedHosts = ["example.com"];
    // if (!allowedHosts.includes(targetUrl.hostname)) {
    //   res.status(403).json({ error: "Domain not allowed" });
    //   return;
    // }

    // Determine upstream method/headers/body:
    const method =
      (req.body && typeof req.body.method === "string" && req.body.method) ||
      req.method;

    const incomingHeaders =
      (req.body && req.body.headers && typeof req.body.headers === "object"
        ? req.body.headers
        : req.headers) || {};

    const headers = { ...incomingHeaders };

    // Remove hop‑by‑hop / origin‑specific headers that shouldn't be forwarded
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    delete headers["accept-encoding"];
    delete headers["content-length"];
    delete headers.connection;

    let body;

    // If client explicitly provided a body in JSON, prefer that; otherwise,
    // for non‑GET/HEAD you might want to forward raw body via middleware (e.g. body-parser).
    if (req.body && typeof req.body.body === "string") {
      body = req.body.body;
    }

    const upstream = await fetch(targetUrl.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });

    // Copy status code
    res.status(upstream.status);

    // Copy headers but drop hop-by-hop ones
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === "content-encoding" ||
        lower === "transfer-encoding" ||
        lower === "content-length" ||
        lower === "connection"
      ) {
        return;
      }
      res.setHeader(key, value);
    });

    // Ensure your frontend can always read this response
    res.setHeader("Access-Control-Allow-Origin", "*");

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error("Proxy error:", err);

    res.status(500).json({ error: "Proxy request failed" });
  }
});

// rewrite rule to remove index.html
app.use(expressUrlrewrite(/^(.+)\/index\.html$/, "$1/"));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");

  const filePath = path.join(__dirname, path.sep, "..", path.sep, req.url);
  fs.stat(filePath, (err, stats) => {
    if (err) {
      next();
      return;
    }

    if (stats.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      fs.access(indexPath, fs.constants.F_OK, (err2) => {
        if (!err2) {
          res.sendFile(indexPath);
        } else {
          next();
        }
      });
    } else {
      res.sendFile(filePath);
    }
  });
});

// serve static files from the 'src' directory
app.use(
  express.static(path.join(__dirname, path.sep, "..", path.sep), {
    etag: true,
  }),
);

const isPortUsed = await tcpPortUsed.check(port, ipAddr);
if (isPortUsed) {
  console.error(
    `Port ${port} is currently being used. Try passing a different port as the first argument.`,
  );

  exit(1);
}

// start the server
app.listen(port, ipAddr, () => {
  console.log(`Server running at http://localhost:${port}`);
});
