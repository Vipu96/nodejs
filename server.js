import express from "express";
import WebSocket from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

// Asetukset (voit tarvittaessa siirtää nämä Renderin ympäristömuuttujiin)
const REGION = process.env.TESLA_REGION || "eu";
const FLEET_GATEWAY_URL = `wss://fleet-api.prd.${REGION}.vn.cloud.tesla.com/v1`;

// Debug-loki (Renderin logeihin)
function log(...args) {
  console.log("[TeslaProxy]", ...args);
}

/**
 * POST /command/:vehicleId/:command
 * Lähettää komennon Teslan Fleet Gatewayhin
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const { token, params, privateKeyPem, domain } = req.body;

  if (!token || !privateKeyPem || !domain) {
    return res.status(400).json({
      error: "Missing required fields (token, privateKeyPem, domain)",
    });
  }

  try {
    // Luo allekirjoitus viestille
    const message = JSON.stringify(params || {});
    const signer = crypto.createSign("SHA256");
    signer.update(message);
    signer.end();
    const key = crypto.createPrivateKey(privateKeyPem);
    const signature = signer.sign(key).toString("base64");

    // Luo WebSocket-yhteys Tesla Fleet Gatewayhin
    const ws = new WebSocket(FLEET_GATEWAY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        res.status(504).json({ error: "Timeout waiting for Tesla response" });
        ws.close();
      }
    }, 10000);

    ws.on("open", () => {
      log("Connected to Tesla Fleet Gateway");

      // 1️⃣ Lähetä handshake
      ws.send(JSON.stringify({
        type: "VehicleCommandHandshake",
        token,
        domain,
      }));

      // 2️⃣ Lähetä komento
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "VehicleCommandRequest",
          command,
          vehicle_id: vehicleId,
          params,
          signature,
        }));
      }, 400);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "VehicleCommandResponse" && !responded) {
          responded = true;
          clearTimeout(timeout);
          log("Received VehicleCommandResponse");
          res.json(msg);
          ws.close();
        } else if (msg.type === "Error") {
          responded = true;
          clearTimeout(timeout);
          res.status(403).json({ error: msg.error || "Forbidden" });
          ws.close();
        }
      } catch (err) {
        responded = true;
        clearTimeout(timeout);
        log("Error parsing Tesla response:", err);
        res.status(500).json({ error: "Invalid response from Tesla" });
      }
    });

    ws.on("error", (err) => {
      responded = true;
      clearTimeout(timeout);
      log("WebSocket error:", err.message);
      if (err.message.includes("403")) {
        res.status(403).json({
          error:
            "Tesla returned 403 – check Virtual Key pairing and token validity.",
        });
      } else if (err.message.includes("ENOTFOUND")) {
        res.status(502).json({
          error:
            "Fleet Gateway hostname not reachable – Tesla endpoint requires partner access.",
        });
      } else {
        res.status(500).json({ error: err.message });
      }
    });

    ws.on("close", () => log("Tesla Fleet Gateway connection closed"));
  } catch (err) {
    log("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (_, res) => {
  res.json({ ok: true, service: "Tesla Render Proxy", region: REGION });
});

// Render/Node kuuntelee porttia
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Server running on port ${PORT}`));
