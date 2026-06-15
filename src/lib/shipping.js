import Store from "../models/Store.js";
import mongoose from "mongoose";
import * as delhivery from "../services/delhivery.service.js";

// Helper to get store shipping config
export const getStoreShippingConfig = async (storeId) => {
  let config = {
    origin: process.env.DELHIVERY_PICKUP_PINCODE || "360001",
    pickupName: process.env.DELHIVERY_PICKUP_NAME || "Store",
    pickupAddress: process.env.DELHIVERY_PICKUP_ADDRESS || "Address",
    pickupCity: process.env.DELHIVERY_PICKUP_CITY || "City",
    pickupState: process.env.DELHIVERY_PICKUP_STATE || "State",
    pickupPhone: process.env.DELHIVERY_PICKUP_PHONE || "9876543210"
  };
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const storeObj = await Store.findById(storeId).select("pickupAddress pickupName pickupPhone");
      if (storeObj?.pickupAddress?.pincode) config.origin = storeObj.pickupAddress.pincode;
      if (storeObj?.pickupName) config.pickupName = storeObj.pickupName;
      if (storeObj?.pickupAddress?.addressLine1) config.pickupAddress = storeObj.pickupAddress.addressLine1;
      if (storeObj?.pickupAddress?.city) config.pickupCity = storeObj.pickupAddress.city;
      if (storeObj?.pickupAddress?.state) config.pickupState = storeObj.pickupAddress.state;
      if (storeObj?.pickupPhone) config.pickupPhone = storeObj.pickupPhone;
    } catch {}
  }
  
  return config;
};

// Calculate volumetric weight from dimensions (in cm)
export const calculateVolumetricWeight = (lengthCm, widthCm, heightCm, quantity = 1) => {
  if (!lengthCm || !widthCm || !heightCm) return 0;
  // Volumetric weight formula: (length * width * height) / 5000 for kg, multiplied by quantity
  return (lengthCm * widthCm * heightCm) / 5000 * quantity;
};

// Main shared shipping calculation function
export const calculateShippingCost = async ({
  origin,
  dest,
  totalWeightGrams,
  orderAmount,
  paymentMethod, // "CASHFREE" or "COD"
  products // array of products with dimensions
}) => {
  let actualWeightKg = totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5;
  let volumetricWeightKg = 0;

  if (products && products.length > 0) {
    volumetricWeightKg = products.reduce((total, p) => {
      const qty = p.quantity || 1;
      return total + calculateVolumetricWeight(
        p.length || 10,
        p.width || 10,
        p.height || 10,
        qty
      );
    }, 0);
  }

  // Use whichever is larger: actual weight or volumetric weight
  const weightKg = Math.max(actualWeightKg, volumetricWeightKg, 0.05);
  const pm = paymentMethod === "COD" ? "cod" : "prepaid";

  return await delhivery.calculateShippingCost({
    origin,
    destination: dest,
    weight: weightKg,
    orderAmount,
    paymentMethod: pm
  });
};
