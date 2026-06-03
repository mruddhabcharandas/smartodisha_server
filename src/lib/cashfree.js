import axios from "axios";

const cashfree = axios.create();

// Use request interceptor to evaluate environment variables at request-time instead of import-time
cashfree.interceptors.request.use((config) => {
  const isProduction = process.env.NODE_ENV === "production";
  config.baseURL = isProduction ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";
  
  config.headers["x-api-version"] = "2022-09-01";
  config.headers["x-client-id"] = process.env.CASHFREE_APP_ID;
  config.headers["x-client-secret"] = process.env.CASHFREE_SECRET_KEY;
  config.headers["Content-Type"] = "application/json";
  
  return config;
}, (error) => {
  return Promise.reject(error);
});

export default cashfree;
