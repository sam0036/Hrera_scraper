export function cleanString(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function isPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function toPositiveNumber(value) {
  return isPositiveNumber(value) ? Number(value) : null;
}

export function isValidEmail(value) {
  const email = cleanString(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPassword(value, minLength = 8) {
  return typeof value === "string" && value.length >= minLength && value.length <= 128;
}

export function methodNotAllowed(res) {
  return res.status(405).json({ error: "Method not allowed" });
}

export function safeError(res, message = "Something went wrong") {
  return res.status(500).json({ error: message });
}