import Store from "../models/Store.js";
import mongoose from "mongoose";
import * as delhivery from "../services/delhivery.service.js";

// Helper to get store shipping config
export const getStoreShippingConfig = async (storeId) => {
  let origin = process.env.DELHIVERY_PICKUP_PINCODE || process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const storeObj = await Store.findById(storeId).select("pickupAddress");
      if (storeObj?.pickupAddress?.pincode) {
        origin = storeObj.pickupAddress.pincode;
      }
    } catch {}
  }
  
  return { origin };
};

// Main shared shipping calculation function
export const calculateShippingCost = async ({
  origin,
  dest,
  totalWeightGrams,
  orderAmount,
  paymentMethod // "CASHFREE" or "COD"
}) => {
  const weightKg = totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5;
  const pm = paymentMethod === "COD" ? "cod" : "prepaid";

  return await delhivery.calculateShippingCost({
    origin,
    destination: dest,
    weight: weightKg,
    orderAmount,
    paymentMethod: pm
  });
};
