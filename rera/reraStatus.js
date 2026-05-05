export function getReraStatusFromExpiry(expiryDate) {
  if (!expiryDate) return "EXPIRED";
  return new Date(expiryDate).getTime() > Date.now() ? "VALID" : "EXPIRED";
}

export function computeBrokerReraStatus(profile) {
  const expiry = profile?.reraExpiryDate || profile?.licenseExpiry || null;
  const status = getReraStatusFromExpiry(expiry);

  return {
    status,
    expiryDate: expiry,
    isVerified: status === "VALID" && Boolean(profile?.isReraVerified),
    message:
      status === "VALID"
        ? "RERA verification is valid"
        : "RERA expired. Please re-verify with the authority or provide a new RERA code if RERA code changed.",
  };
}