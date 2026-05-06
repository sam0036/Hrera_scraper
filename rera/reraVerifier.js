import puppeteer from "puppeteer";
import { getReraStatusFromExpiry } from "./reraStatus.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();
const inProgress = new Map();

export function parseReraDate(value) {
  if (!value) return null;
  const text = String(value).trim();

  const ddmmyyyy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function cacheKey(reraNumber, state) {
  return `${String(state || "").toLowerCase()}::${String(reraNumber || "").toLowerCase()}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

async function scrapeHaryanaDatabase(reraNumber) {
  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_KEY}&--proxy-server=http://136.226.254.24:12360`,
    });

    const page = await browser.newPage();

    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(25000);

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();

      if (["image", "font", "media"].includes(resourceType)) {
        request.abort();
        return;
      }

      request.continue();
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
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
      const normalizedTarget = targetID.trim().toLowerCase();

      const match = rows.find((row) => {
        const cells = row.querySelectorAll("td");
        return cells[1]?.innerText.trim().toLowerCase() === normalizedTarget;
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
        message: "RERA number was not found",
      };
    }

    const parsedValidity = parseReraDate(data.validity);
    const verificationStatus = getReraStatusFromExpiry(parsedValidity);

    return {
      success: true,
      status: verificationStatus,
      data: {
        ...data,
        parsedValidity,
      },
    };

  } catch (error) {
    console.error("SCRAPER ERROR:", error.message);

    return {
      success: false,
      status: "FAILED",
      message: "RERA authority verification is temporarily unavailable",
    };

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

export async function verifyRera(reraNumber, state = "Haryana") {
  const normalizedNumber = String(reraNumber || "").trim();
  const normalizedState = String(state || "").trim();

   if (!normalizedNumber) {
    return { success: false, status: "INVALID_INPUT", message: "RERA number is required" };
  }

  if (normalizedState && normalizedState.toLowerCase() !== "haryana") {
    return {
      success: false,
      status: "UNSUPPORTED_STATE",
      message: "Automated verification is currently available for Haryana RERA only",
    };
  }

  const key = cacheKey(normalizedNumber, normalizedState || "Haryana");
  const cached = getCached(key);
  if (cached) return cached;

  if (inProgress.has(key)) return inProgress.get(key);

  const promise = scrapeHaryanaDatabase(normalizedNumber);
  inProgress.set(key, promise);

  try {
    const result = await promise;
    if (result.success) {
      cache.set(key, { value: result, cachedAt: Date.now() });
    }

    return result;
  } finally {
    inProgress.delete(key);
  }
}
