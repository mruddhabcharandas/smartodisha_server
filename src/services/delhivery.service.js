import fetch from "node-fetch";

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const base = () => _sanitize(process.env.DELHIVERY_BASE_URL || "");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

export const checkServiceability = async (pincode) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const url = `${b}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
  const res = await fetch(url, { headers: authHeader() });
  const data = await res.json();
  const hasCodes = Array.isArray(data) ? data.length > 0 : Array.isArray(data?.delivery_codes) ? data.delivery_codes.length > 0 : !!data;
  return {
    pincode,
    delivery_available: hasCodes,
    cod_available: hasCodes
  };
};
