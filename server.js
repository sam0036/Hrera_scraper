import express from "express";
import { verifyRera } from "./rera/reraVerifier.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HRERA Scraper is running" });
});

/**
 * POST /verify
 * Body: { reraNumber: "HRERA-PKL-REA-1234-2022", state: "Haryana" }
 */
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
    console.error("Server error:", err);
    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message: "Internal server error",
    });
  }
});

/**
 * GET /verify/:reraNumber
 * e.g. GET /verify/HRERA-PKL-REA-1234-2022
 */
app.get("/verify/:reraNumber", async (req, res) => {
  const { reraNumber } = req.params;
  const state = req.query.state || "Haryana";

  try {
    const result = await verifyRera(reraNumber, state);
    return res.json(result);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message: "Internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`HRERA Scraper server running on port ${PORT}`);
});
