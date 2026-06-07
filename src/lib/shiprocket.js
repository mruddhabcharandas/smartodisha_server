import axios from "axios";

const tokenCache = new Map();
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const resolveCredentials = (credentials = {}) => ({
  email: credentials.email || process.env.SHIPROCKET_EMAIL,
  password: credentials.password || process.env.SHIPROCKET_PASSWORD
});

export const getShiprocketToken = async (credentials = {}) => {
  const { email, password } = resolveCredentials(credentials);
  if (!email || !password) {
    const err = new Error("shiprocket_credentials_missing");
    err.response = { data: { message: "Shiprocket API credentials not configured", status_code: 403 } };
    throw err;
  }

  const cacheKey = email;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }

  try {
    const response = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      { email, password },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    const token = response.data?.token;
    if (!token) {
      throw new Error("shiprocket_token_missing");
    }

    tokenCache.set(cacheKey, { token, expiry: Date.now() + TOKEN_TTL_MS });
    return token;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error("Failed to get Shiprocket token:", data || error.message);
    if (status === 403 || status === 401) {
      console.error(
        "Shiprocket auth failed. Verify SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD in .env or store Shiprocket credentials in seller profile."
      );
    }
    throw error;
  }
};

export const createShiprocketClient = (credentials = {}) => {
  const client = axios.create({
    baseURL: "https://apiv2.shiprocket.in/v1/external",
    timeout: 20000
  });

  client.interceptors.request.use(async (config) => {
    const token = await getShiprocketToken(credentials);
    config.headers.Authorization = `Bearer ${token}`;
    return config;
  });

  return client;
};

const defaultClient = createShiprocketClient();

export const checkServiceability = async (params, credentials = {}) => {
  const client = credentials.email || credentials.password
    ? createShiprocketClient(credentials)
    : defaultClient;

  const payload = {
    pickup_postcode: String(params.pickup_postcode || "").trim(),
    delivery_postcode: String(params.delivery_postcode || "").trim(),
    weight: Math.max(0.5, Number(params.weight) || 0.5),
    cod: params.cod ? 1 : 0
  };

  if (!payload.pickup_postcode || !payload.delivery_postcode) {
    throw new Error("missing_postcodes");
  }

  return client.get("/courier/serviceability", { params: payload });
};

export default defaultClient;
