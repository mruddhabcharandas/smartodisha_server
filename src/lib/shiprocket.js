import axios from "axios";

let shiprocketToken = null;
let tokenExpiry = 0;

const getShiprocketToken = async () => {
  if (shiprocketToken && Date.now() < tokenExpiry) {
    return shiprocketToken;
  }

  try {
    const response = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD
    });
    
    shiprocketToken = response.data.token;
    tokenExpiry = Date.now() + (8 * 60 * 60 * 1000); // 8 hours
    return shiprocketToken;
  } catch (error) {
    console.error("Failed to get Shiprocket token:", error.response?.data || error.message);
    throw error;
  }
};

const shiprocket = axios.create({
  baseURL: "https://apiv2.shiprocket.in/v1/external"
});

shiprocket.interceptors.request.use(async (config) => {
  const token = await getShiprocketToken();
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default shiprocket;
