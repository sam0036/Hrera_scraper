import express from "express";
import { verifyRera } from "./rera/reraVerifier.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HRERA Scraper is running" });
});

// ---------------- POST /verify ----------------
// Body: { reraNumber, state }
app.post("/verify", async (req, res) => {
  const { reraNumber, state } = req.body;

  if (!reraNumber) {
    return res.status(400).json({
      success: false,
      status: "INVALID_INPUT",
      message: "reraNumber is required in request body",
    });
  }

  try {
    const result = await verifyRera(reraNumber, state || "Haryana");
    return res.json(result);
  } catch (err) {
    console.error("POST /verify error:", err);
    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message: "Internal server error",
    });
  }
});

// ---------------- GET /verify/:reraNumber ----------------
// Example: /verify/HRERA-PKL-REA-1234-2022
app.get("/verify/:reraNumber", async (req, res) => {
  const { reraNumber } = req.params;
  const state = req.query.state || "Haryana";

  try {
    const result = await verifyRera(reraNumber, state);
    return res.json(result);
  } catch (err) {
    console.error("GET /verify/:reraNumber error:", err);
    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message: "Internal server error",
    });
  }
});

// ---------------- NEW: GET /verify?reraNumber=... ----------------
// Example: /verify?reraNumber=HRERA-PKL-REA-1234-2022
app.get("/verify", async (req, res) => {
  const { reraNumber, state } = req.query;

  if (!reraNumber) {
    return res.status(400).json({
      success: false,
      status: "INVALID_INPUT",
      message: "reraNumber query param is required",
    });
  }

  try {
    const result = await verifyRera(reraNumber, state || "Haryana");
    return res.json(result);
  } catch (err) {
    console.error("GET /verify error:", err);
    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message: "Internal server error",
    });
  }
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log(`HRERA Scraper server running on port ${PORT}`);
});
