import express from "express";
import cors from "cors";
import crypto from "crypto";
import WebSocket from "ws";

const app = express();
app.use(cors());
app.use(express.json());

// === Environment variables ===
const TESLA_PRIVATE_KEY = process.env.TESLA_PRIVATE_KEY;    // EC P-256 private key (PEM)
const TESLA_PUBLIC_KEY  = process.env.TESLA_PUBLIC_KEY;     // EC P-256 public key (PEM)
const TESLA_REGION      = process.env.TESLA_REGION || "eu"; // "eu" / "na"
const TESLA_DOMAIN      = process.env.TESLA_DOMAIN || "myspot.fi"; // sama domain kuin avain on lisätty

// === Utility functions ===
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signMessageBase64Url(messageB64Url) {
  const sign = crypto.createSign("sha256");
  sign.update(messageB64Url);
  sign.end();
  const sigDER = sign.sign(TESLA_PRIVATE_KEY); // returns DER
  return b64url(sigDER);
}

// === Root endpoint ===
app.get("/", (_req, res) => {
  res.send("🚀 Tesla VCP proxy is up. Routes: /.well-known/... , POST /vcp/command/:vehicleId/:command");
});

// === Tesla public key endpoint ===
app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", (_req, res) => {
  if (!TESLA_PUBLIC_KEY) return res.status(500).send("TESLA_PUBLIC_KEY not set");
  res.type("application/x-pem-file").send(TESLA_PUBLIC_KEY);
});

// === Vehicle Command Protocol endpoint ===
app.post("/vcp/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Missing or invalid Authorization header" });
  }
  if (!TESLA_PRIVATE_KEY) {
    return res.status(500).json({ ok: false, error: "TESLA_PRIVATE_KEY not configured" });
  }

  const params = req.body && typeof req.body === "object" ? req.body : {};
  const messageJson = JSON.stringify(params ?? {});
  const messageB64Url = b64url(Buffer.from(messageJson, "utf8"));
  const signatureB64Url = signMessageBase64Url(messageB64Url);

  // ✅ Correct Tesla Fleet Gateway WebSocket endpoint
  const wsUrl = `wss://fleet-vehicle-command.prd.${TESLA_REGION}.vn.cloud.tesla.com/v1`;

  // Prepare handshake and command payloads
  const handshake = {
    type: "VehicleCommandHandshake",
    domain: TESLA_DOMAIN,
  };

  const requestMsg = {
    type: "VehicleCommandRequest",
    command,
    vehicle_id: vehicleId,
    message: messageB64Url,
    signature: signatureB64Url,
  };

  let settled = false;
  const timeoutMs = 15000;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { ws.close(); } catch (_) {}
      res.status(504).json({ ok: false, error: "VCP timeout" });
    }
  }, timeoutMs);

  const ws = new WebSocket(wsUrl, { headers: { Authorization: auth } });

  ws.on("open", () => {
    try {
      ws.send(JSON.stringify(handshake));
      setTimeout(() => ws.send(JSON.stringify(requestMsg)), 150);
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        res.status(500).json({ ok: false, error: "Handshake/Send failed", details: String(e) });
      }
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "VehicleCommandResponse" || msg.result !== undefined) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res.status(200).json({ ok: true, txid: msg.txid, response: msg });
          ws.close();
        }
      }
    } catch (e) {
      // ignore non-JSON frames
    }
  });

  ws.on("error", (err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      res.status(502).json({ ok: false, error: "WebSocket error", details: String(err?.message || err) });
    }
  });

  ws.on("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      res.status(502).json({ ok: false, error: "WebSocket closed before response" });
    }
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚗 Tesla VCP proxy listening on port ${port} (region=${TESLA_REGION}, domain=${TESLA_DOMAIN})`);
});
