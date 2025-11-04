import express from "express";
import WebSocket from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

// Read region from environment or use EU by default
const REGION = process.env.TESLA_REGION || "eu";

// New Fleet API gateway according to 2025 guidelines
const FLEET_GATEWAY_URL = `wss://fleet-api.prd.${REGION}.vn.cloud.tesla.com/v1`;

app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const { token, params, privateKeyPem, domain } = req.body;

  if (!token || !privateKeyPem || !domain) {
    return res
      .status(400)
      .json({ error: "Missing required fields (token, privateKeyPem, domain)" });
  }

  try {
    // Handshake message
    const handshake = {
      type: "VehicleCommandHandshake",
      token,
      domain,
    };

    // Sign the command parameters
    const message = JSON.stringify(params || {});
    const signer = crypto.createSign("SHA256");
    signer.update(message);
    signer.end();
    const key = crypto.createPrivateKey(privateKeyPem);
    const signature = signer.sign(key).toString("base64");

    // Compose the command message
    const commandMsg = {
      type: "VehicleCommandRequest",
      command,
      vehicle_id: vehicleId,
      params,
      signature,
    };

    const ws = new WebSocket(FLEET_GATEWAY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let responded = false;
    ws.on("open", () => {
      ws.send(JSON.stringify(handshake));
      setTimeout(() => ws.send(JSON.stringify(commandMsg)), 400);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "VehicleCommandResponse" && !responded) {
          responded = true;
          res.json(msg);
          ws.close();
        }
      } catch (err) {
        console.error("Invalid JSON from Tesla:", data.toString());
      }
    });

    ws.on("error", (err) => {
      if (!responded) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get("/", (_req, res) => {
  res.send("✅ Tesla VCP Proxy (Fleet API v2025) running");
});

const port = process.env.PORT || 8787;
app.listen(port, () =>
  console.log(`🚀 Tesla VCP Proxy ready on port ${port} | Region: ${REGION}`)
);
