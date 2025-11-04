import express from "express";
import WebSocket from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

// --- REGION asetetaan ympäristömuuttujasta tai oletuksena EU ---
const REGION = process.env.TESLA_REGION || "eu";

// --- Tesla Fleet Gatewayn uusi osoite (2025-07-21 jälkeen) ---
const FLEET_GATEWAY_URL = `wss://fleet-api.prd.${REGION}.vn.cloud.tesla.com/v1`;

// --- Tesla token endpoint diagnostiikkaa varten ---
const FLEET_AUTH_URL = `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`;

app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const { token, params, privateKeyPem, domain } = req.body;

  if (!token || !privateKeyPem || !domain) {
    return res.status(400).json({ error: "Missing required fields (token/privateKeyPem/domain)" });
  }

  console.log(`🔌 Incoming command: ${command} for vehicle ${vehicleId}`);

  try {
    // 1️⃣ Alustetaan handshake Tesla Fleet Gatewaylle
    const handshake = {
      type: "VehicleCommandHandshake",
      token,
      domain,
    };

    // 2️⃣ Allekirjoitetaan komento yksityisellä avaimella (ECDSA)
    const message = JSON.stringify(params || {});
    const sign = crypto.createSign("SHA256");
    sign.update(message);
    sign.end();

    const key = crypto.createPrivateKey(privateKeyPem);
    const signature = sign.sign(key).toString("base64");

    // 3️⃣ Rakennetaan varsinainen komento
    const commandMsg = {
      type: "VehicleCommandRequest",
      command,
      vehicle_id: vehicleId,
      params,
      signature,
    };

    // 4️⃣ Luodaan WebSocket-yhteys Fleet API Gatewayhin
    const ws = new WebSocket(FLEET_GATEWAY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let responded = false;

    ws.on("open", () => {
      console.log("✅ WebSocket connected to Tesla Fleet Gateway");
      ws.send(JSON.stringify(handshake));
      setTimeout(() => ws.send(JSON.stringify(commandMsg)), 400);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log("📩 Received:", msg);

        if (msg.type === "VehicleCommandResponse" && !responded) {
          responded = true;
          res.json(msg);
          ws.close();
        }
      } catch (err) {
        console.error("Invalid JSON from Tesla:", data.toString());
      }
    });

    ws.on("close", () => {
      console.log("🔌 WebSocket closed");
    })
