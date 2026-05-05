import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { getReraStatusFromExpiry } from "./reraStatus.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

const cache = new Map();
const inProgress = new Map();

// ---------------- UTIL: sleep ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- UTIL: retry ----------------
async function withRetries(fn, retries = MAX_RETRIES) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;

      const isBlocked = err.message === "IP_BLOCKED";

      // exponential backoff
      const delay = isBlocked ? 5000 * (i + 1) : 1500 * (i + 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ---------------- DATE PARSER ----------------
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

// ---------------- CACHE ----------------
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

// ---------------- SCRAPER CORE ----------------
async function scrapeHaryanaDatabase(reraNumber) {
  return withRetries(async (attempt) => {
    let browser;

    try {
      const executablePath = await chromium.executablePath();
      if (!executablePath) throw new Error("Chromium executable not found");

      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
          "--no-zygote",
        ],
        executablePath,
        headless: true,
      });

      const page = await browser.newPage();

      await page.setViewport({ width: 1366, height: 768 });

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
      );

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        window.chrome = { runtime: {} };
      });

      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(30000);

      // block heavy resources only
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const type = req.resourceType();
        if (["image", "font", "media"].includes(type)) req.abort();
        else req.continue();
      });

      // navigate
      await page.goto(
        "https://haryanarera.gov.in/admincontrol/registered_agents/2",
        { waitUntil: "domcontentloaded" }
      );

      // detect blocking
      const title = await page.title();
      if (title.toLowerCase().includes("access denied")) {
        throw new Error("IP_BLOCKED");
      }

      const searchSelector = 'input[type="search"]';
      await page.waitForSelector(searchSelector);

      // clear + type
      await page.click(searchSelector, { clickCount: 3 });
      await page.keyboard.press("Backspace");

      await page.type(searchSelector, reraNumber, { delay: 80 });
      await page.keyboard.press("Enter");

      // 🔥 resilient wait (handles slow AJAX)
      await page.waitForFunction(
        (target) => {
          const rows = document.querySelectorAll("table tbody tr");
          if (!rows.length) return false;

          return Array.from(rows).some((row) =>
            row.innerText.toLowerCase().includes(target.toLowerCase())
          );
        },
        { timeout: 20000 },
        reraNumber
      );

      // extract
      const data = await page.evaluate((targetID) => {
        const normalize = (str) =>
          String(str || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[^a-z0-9 ]/g, "")
            .trim();

        const target = normalize(targetID);

        const rows = Array.from(document.querySelectorAll("table tbody tr"));

        const match = rows.find((row) => {
          const cells = row.querySelectorAll("td");
          return normalize(cells[1]?.innerText) === target;
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
          message: "RERA number not found",
        };
      }

      const parsedValidity = parseReraDate(data.validity);
      const verificationStatus = getReraStatusFromExpiry(parsedValidity);

      return {
        success: true,
        status: verificationStatus,
        data: { ...data, parsedValidity },
      };
    } finally {
      if (browser) await browser.close();
    }
  });
}

// ---------------- MAIN ----------------
export async function verifyRera(reraNumber, state = "Haryana") {
  const normalizedNumber = String(reraNumber || "").trim();
  const normalizedState = String(state || "").trim();

  if (!normalizedNumber) {
    return {
      success: false,
      status: "INVALID_INPUT",
      message: "RERA number is required",
    };
  }

  if (normalizedState.toLowerCase() !== "haryana") {
    return {
      success: false,
      status: "UNSUPPORTED_STATE",
      message: "Only Haryana supported",
    };
  }

  const key = cacheKey(normalizedNumber, normalizedState);

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
  } catch (error) {
    return {
      success: false,
      status: error.message === "IP_BLOCKED" ? "BLOCKED" : "FAILED",
      message: "Verification temporarily unavailable",
    };
  } finally {
    inProgress.delete(key);
  }
}