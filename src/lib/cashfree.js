import axios from "axios";

const cashfree = axios.create({
  baseURL: process.env.NODE_ENV === "production" 
    ? "https://api.cashfree.com" 
    : "https://sandbox.cashfree.com",
  headers: {
    "x-api-version": "2022-09-01",
    "x-client-id": process.env.CASHFREE_APP_ID,
    "x-client-secret": process.env.CASHFREE_SECRET_KEY,
    "Content-Type": "application/json"
  }
});

export default cashfree;
