
import { checkServiceability, createShiprocketClient } from "./shiprocket.js";
import Store from "../models/Store.js";
import mongoose from "mongoose";

// Helper to find best courier (prioritize Delhivery, then Blue Dart)
export const findBestCourier = (couriers) => {
  if (!Array.isArray(couriers)) return null;
  
  // Priority 1: Delhivery
  const delhivery = couriers.find(c => 
    String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('delhivery')
  );
  if (delhivery) return delhivery;
  
  // Priority 2: Blue Dart
  const blueDart = couriers.find(c => 
    String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('blue dart') ||
    String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('bluedart')
  );
  if (blueDart) return blueDart;
  
  // Fallback: first available
  return couriers[0];
};

// Helper to get store Shiprocket credentials and pickup pincode
export const getStoreShippingConfig = async (storeId) => {
  let origin = process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
  let srEmail = process.env.SHIPROCKET_EMAIL;
  let srPassword = process.env.SHIPROCKET_PASSWORD;
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const storeObj = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword pickupAddress");
      if (storeObj) {
        if (storeObj.shiprocketEmail && storeObj.shiprocketPassword) {
          srEmail = storeObj.shiprocketEmail;
          srPassword = storeObj.shiprocketPassword;
        }
        if (storeObj.pickupAddress?.pincode) {
          origin = storeObj.pickupAddress.pincode;
        }
      }
    } catch {}
  }
  
  return { origin, srEmail, srPassword };
};

// Main shared shipping calculation function
export const calculateShippingCost = async ({
  origin,
  dest,
  totalWeightGrams,
  orderAmount,
  paymentMethod, // "CASHFREE" or "COD"
  srEmail,
  srPassword
}) => {
  const weight = totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5;
  const paymentMethodForShipping = paymentMethod === "CASHFREE" ? "prepaid" : "cod";
  
  let baseAmt = 85;
  let selectedCourier = null;
  let freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
  
  // First try Shiprocket serviceability
  try {
    if (origin && dest) {
      const response = await checkServiceability({
        pickup_postcode: origin,
        delivery_postcode: dest,
        weight,
        cod: paymentMethod === "COD"
      }, { email: srEmail, password: srPassword });
      
      const data = response.data;
      const courierList = data?.data?.available_courier_companies
        || data?.data?.couriers
        || data?.couriers
        || [];
      
      if (Array.isArray(courierList) && courierList.length) {
        selectedCourier = findBestCourier(courierList);
      }
      
      baseAmt = Number(
        selectedCourier?.rate
        || selectedCourier?.freight_charge
        || data?.data?.available_courier_companies?.[0]?.rate
        || data?.rate
        || process.env.SHIPPING_BASE_CHARGE
        || 85
      );
    }
  } catch {
    // Fallback calculation
    const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
    const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
    const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
    const variable = perKg * weight;
    baseAmt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
  }
  
  const isPrepaidFree = orderAmount >= freeDeliveryAbove && paymentMethodForShipping === 'prepaid';
  const deliveryCharge = isPrepaidFree ? 0 : baseAmt;
  
  // COD charge: 5% or min ₹40, max ₹100
  const codCharge = paymentMethod === "COD" 
    ? Math.min(Math.max(Math.round(orderAmount * 0.05), 40), 100) 
    : 0;
  
  const finalCharge = deliveryCharge + codCharge;
  const codAvailable = orderAmount <= 2000;
  
  return {
    deliveryCharge,
    codCharge,
    finalCharge,
    codAvailable,
    isFreeDelivery: isPrepaidFree,
    selectedCourier: selectedCourier?.name || 'Delhivery',
    baseAmt,
    weight
  };
};

