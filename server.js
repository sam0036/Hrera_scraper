import express from "express";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- SCRAPER FUNCTION ----------------
async function scrapeHaryanaDatabase(reraNumber) {
  let browser;

  try {
    // ✅ Browserless connection
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_KEY}`,
    });

    const page = await browser.newPage();

    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(25000);

    // ✅ lightweight blocking (SAFE)
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();

      if (["image", "font", "media"].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"
    );

    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(
      "https://haryanarera.gov.in/admincontrol/registered_agents/2",
      {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      }
    );

    console.log("PAGE TITLE:", await page.title());

    const searchSelector = 'input[type="search"]';

    await page.waitForSelector(searchSelector, { timeout: 15000 });

    await page.click(searchSelector, { clickCount: 3 });
    await page.type(searchSelector, reraNumber, { delay: 5 });

    await page.waitForSelector("table tbody tr", { timeout: 15000 });

    const data = await page.evaluate((targetID) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const target = targetID.trim().toLowerCase();

      const match = rows.find((row) => {
        const cells = row.querySelectorAll("td");
        return cells[1]?.innerText.trim().toLowerCase() === target;
      });

      if (!match) return null;

      const cells = match.querySelectorAll("td");

      return {
        registrationNumber: cells[1]?.innerText.trim() || "",
        agentName: cells[2]?.innerText.trim() || "",
        district: cells[3]?.innerText.trim() || "",
        status: cells[4]?.innerText.trim() || "",
        validity: cells[6]?.innerText.trim() || "",
      };
    }, reraNumber);

    if (!data) {
      return {
        success: false,
        status: "NOT_FOUND",
      };
    }

    return {
      success: true,
      data,
    };

  } catch (error) {
    console.error("SCRAPER ERROR:", error.message);

    return {
      success: false,
      status: "FAILED",
    };

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

// ---------------- API ROUTE ----------------
app.get("/verify", async (req, res) => {
  try {
    const { reraNumber } = req.query;

    if (!reraNumber) {
      return res.status(400).json({
        success: false,
        message: "reraNumber is required",
      });
    }

    const result = await scrapeHaryanaDatabase(reraNumber);

    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ---------------- ROOT ROUTE ----------------
app.get("/", (req, res) => {
  res.send("API is running");
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
