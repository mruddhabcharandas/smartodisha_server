import fetch from 'node-fetch';

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const base = () => _sanitize(process.env.DELHIVERY_BASE_URL || "https://staging-express.delhivery.com");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

// Constants
const DEFAULT_WEIGHT = 0.5;
const DEFAULT_BASE_RATE = 85;
const DEFAULT_PER_KG_RATE = 0;
const DEFAULT_FREE_DELIVERY_ABOVE = 999;
const DEFAULT_COD_MAX_LIMIT = 20000;

/**
 * Check serviceability for a pincode
 */
export const checkServiceability = async (pincode) => {
  const b = base();
  if (!b || !token()) {
    console.log("Delhivery not configured, using fallback");
    return getFallbackServiceability(pincode);
  }

  try {
    const url = `${b}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
    console.log("Checking serviceability at:", url);
    
    const res = await fetch(url, { headers: authHeader() });
    console.log("Delhivery serviceability status:", res.status, res.statusText);
    
    if (!res.ok) {
      console.error(`Delhivery API returned ${res.status}`);
      return getFallbackServiceability(pincode);
    }
    
    const text = await res.text();
    console.log("Delhivery serviceability response body:", text);
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      console.error("Failed to parse Delhivery serviceability JSON:", jsonErr);
      return getFallbackServiceability(pincode);
    }
    
    console.log("Delhivery serviceability data:", data);
    
    // Parse the response
    const result = parseServiceabilityResponse(data, pincode);
    console.log("Parsed serviceability result:", result);
    
    return result;
  } catch (err) {
    console.error("Delhivery serviceability check failed, using fallback:", err);
    return getFallbackServiceability(pincode);
  }
};

/**
 * Parse serviceability response from Delhivery
 */
const parseServiceabilityResponse = (data, pincode) => {
  let delivery_available = false;
  let cod_available = false;
  
  // Check if API returned an error
  if (data?.success === false) {
    console.log("Delhivery API error:", data?.rmk || "Unknown error");
    return getFallbackServiceability(pincode);
  }
  
  // Check for delivery_codes array
  if (data?.delivery_codes && Array.isArray(data.delivery_codes)) {
    if (data.delivery_codes.length === 0) {
      console.log("Delhivery: Empty delivery_codes list → NSZ (non-serviceable)");
      return getFallbackServiceability(pincode, false);
    }
    
    // Process each delivery code
    for (const dc of data.delivery_codes) {
      if (!dc) continue;
      
      // Check postal code object
      const postalCode = dc.postal_code || dc;
      
      // If remark is "Embargo" → skip (temporary NSZ)
      if (postalCode.remark === "Embargo") {
        console.log("Delhivery: Pincode has Embargo remark → temporary NSZ");
        continue;
      }
      
      // Check if it's serviceable
      if (postalCode.postal_code === pincode || !postalCode.postal_code) {
        delivery_available = true;
        // Check if COD is available
        if (postalCode.cod === true || postalCode.cod === "true" || postalCode.cod === 1) {
          cod_available = true;
        }
        break; // Found serviceability for this pincode
      }
    }
  } 
  // Check for delivery_codes as object
  else if (data?.delivery_codes?.postal_code) {
    const pc = data.delivery_codes.postal_code;
    if (pc.remark !== "Embargo") {
      delivery_available = true;
      cod_available = pc.cod === true || pc.cod === "true" || pc.cod === 1;
    }
  } 
  // Handle alternative response format
  else if (data?.status === "success" && data?.data?.serviceability) {
    const serviceability = data.data.serviceability;
    if (Array.isArray(serviceability)) {
      for (const item of serviceability) {
        if (item.pincode === pincode) {
          delivery_available = item.available === true;
          cod_available = item.cod_available === true;
          break;
        }
      }
    }
  }
  // Fallback if unrecognized format
  else {
    console.log("Unrecognized Delhivery serviceability response, using fallback");
    return getFallbackServiceability(pincode);
  }

  return {
    pincode,
    delivery_available,
    cod_available,
    eta: delivery_available ? 3 : null
  };
};

/**
 * Get fallback serviceability response
 */
const getFallbackServiceability = (pincode, available = true) => ({
  pincode,
  delivery_available: available,
  cod_available: available,
  eta: available ? 3 : null
});

/**
 * Calculate shipping cost
 */
export const calculateShippingCost = async ({ origin, destination, weight, orderAmount, paymentMethod }) => {
  try {
    // Validate inputs
    const weightKg = Math.max(DEFAULT_WEIGHT, parseFloat(weight) || DEFAULT_WEIGHT);
    const orderAmt = parseFloat(orderAmount) || 0;
    const payment = String(paymentMethod || "").toLowerCase();
    
    // Get configuration
    const baseRate = parseFloat(process.env.DELHIVERY_BASE_RATE) || DEFAULT_BASE_RATE;
    const perKgRate = parseFloat(process.env.DELHIVERY_PER_KG_RATE) || DEFAULT_PER_KG_RATE;
    const freeDeliveryAbove = parseFloat(process.env.FREE_DELIVERY_ABOVE) || DEFAULT_FREE_DELIVERY_ABOVE;
    const codMaxLimit = parseFloat(process.env.COD_MAX_LIMIT) || DEFAULT_COD_MAX_LIMIT;
    
    // Check if COD is available for this pincode (if destination provided)
    let codAvailable = true;
    if (destination) {
      try {
        const serviceability = await checkServiceability(destination);
        codAvailable = serviceability.cod_available;
      } catch (err) {
        console.warn("Could not check COD availability, assuming available:", err);
      }
    }
    
    // Calculate shipping charge
    let shippingCharge = baseRate + (perKgRate * (weightKg - DEFAULT_WEIGHT));
    shippingCharge = Math.max(0, shippingCharge); // Ensure non-negative
    
    // Free delivery if order amount exceeds threshold
    const isFreeDelivery = payment !== 'cod' && orderAmt >= freeDeliveryAbove;
    const finalDeliveryCharge = isFreeDelivery ? 0 : shippingCharge;
    
    // COD charge: 5% or min ₹40, max ₹100
    let codCharge = 0;
    if (payment === 'cod') {
      codCharge = Math.min(Math.max(Math.round(orderAmt * 0.05), 40), 100);
      // Only charge COD if COD is available
      if (!codAvailable) {
        codCharge = 0;
      }
    }
    
    // Check if order amount exceeds COD limit
    const exceedsCodLimit = orderAmt > codMaxLimit;
    
    return {
      deliveryCharge: Math.round(finalDeliveryCharge * 100) / 100,
      codCharge: Math.round(codCharge * 100) / 100,
      finalCharge: Math.round((finalDeliveryCharge + codCharge) * 100) / 100,
      codAvailable: codAvailable && !exceedsCodLimit,
      codLimit: codMaxLimit,
      isFreeDelivery,
      selectedCourier: 'Delhivery',
      baseAmt: baseRate,
      weight: weightKg,
      exceedsCodLimit
    };
  } catch (error) {
    console.error("Delhivery shipping calculation failed, using fallback:", error);
    return getFallbackShippingCost({ weight, orderAmount, paymentMethod });
  }
};

/**
 * Get fallback shipping cost
 */
const getFallbackShippingCost = ({ weight, orderAmount, paymentMethod }) => {
  const weightKg = Math.max(DEFAULT_WEIGHT, parseFloat(weight) || DEFAULT_WEIGHT);
  const orderAmt = parseFloat(orderAmount) || 0;
  const payment = String(paymentMethod || "").toLowerCase();
  
  const baseRate = parseFloat(process.env.SHIPPING_BASE_CHARGE) || DEFAULT_BASE_RATE;
  const perKgRate = parseFloat(process.env.SHIPPING_PER_KG_CHARGE) || DEFAULT_PER_KG_RATE;
  const minCharge = parseFloat(process.env.SHIPPING_MIN_CHARGE) || DEFAULT_BASE_RATE;
  const freeDeliveryAbove = parseFloat(process.env.FREE_DELIVERY_ABOVE) || DEFAULT_FREE_DELIVERY_ABOVE;
  const codMaxLimit = parseFloat(process.env.COD_MAX_LIMIT) || DEFAULT_COD_MAX_LIMIT;
  
  let shippingCharge = Math.max(minCharge, baseRate + (perKgRate * (weightKg - DEFAULT_WEIGHT)));
  
  const isFreeDelivery = payment !== 'cod' && orderAmt >= freeDeliveryAbove;
  const finalDeliveryCharge = isFreeDelivery ? 0 : shippingCharge;
  
  const codCharge = payment === 'cod' 
    ? Math.min(Math.max(Math.round(orderAmt * 0.05), 40), 100) 
    : 0;
  
  const exceedsCodLimit = orderAmt > codMaxLimit;
  
  return {
    deliveryCharge: Math.round(finalDeliveryCharge * 100) / 100,
    codCharge: Math.round(codCharge * 100) / 100,
    finalCharge: Math.round((finalDeliveryCharge + codCharge) * 100) / 100,
    codAvailable: !exceedsCodLimit,
    codLimit: codMaxLimit,
    isFreeDelivery,
    selectedCourier: 'Delhivery (Fallback)',
    baseAmt: baseRate,
    weight: weightKg,
    exceedsCodLimit
  };
};

/**
 * Create a shipment in Delhivery
 */
export const createShipment = async (shipmentData) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured. Please set DELHIVERY_BASE_URL and DELHIVERY_API_TOKEN");
  }

  const url = `${b}/api/cmu/create.json`;
  console.log("Delhivery API URL:", url);

  try {
    // Prepare payload
    let payload = shipmentData;
    
    // Unwrap if needed
    if (shipmentData?.data?.shipments) {
      payload = shipmentData.data;
    }
    
    // Validate payload structure
    if (!payload?.shipments?.[0]) {
      throw new Error("Invalid shipment data: missing shipments array");
    }
    
    // Clean and prepare shipment data
    const s = payload.shipments[0];
    
    // Remove fields that cause validation issues
    const fieldsToRemove = [
      'products', 'shipping_mode', 'ewaybill_value', 'ewaybill_date',
      'ewaybill_validity', 'ewaybill_no', 'seller_gst_tin', 'address2'
    ];
    fieldsToRemove.forEach(field => delete s[field]);
    
    // Remove empty fields
    Object.keys(s).forEach(key => {
      if (s[key] === "" || s[key] === null || s[key] === undefined) {
        delete s[key];
      }
    });
    
    // Map common field names to Delhivery expected names
    const fieldMapping = {
      'address': 'add',
      'pincode': 'pin',
      'order_id': 'order',
      'orderId': 'order',
      'zip': 'pin',
      'zipcode': 'pin'
    };
    
    Object.keys(fieldMapping).forEach(oldKey => {
      if (s[oldKey] && !s[fieldMapping[oldKey]]) {
        s[fieldMapping[oldKey]] = s[oldKey];
        delete s[oldKey];
      }
    });
    
    // Set required fields with defaults
    s.total_amount = Math.max(1, Number(s.total_amount) || 1);
    s.order_date = new Date().toISOString().slice(0, 10);
    s.weight = Number(s.weight || DEFAULT_WEIGHT);
    
    // Validate required Delhivery fields
    const requiredFields = [
      'name',      // Customer name
      'phone',     // Customer phone
      'add',       // Address
      'city',      // City
      'state',     // State
      'pin',       // Pincode
      'order'      // Order ID
    ];
    
    for (const field of requiredFields) {
      if (!String(s[field] || "").trim()) {
        throw new Error(`Missing required shipment field: ${field}`);
      }
    }
    
    // Set pickup location
    payload.pickup_location = String(payload.pickup_location || "").trim();
    if (!payload.pickup_location) {
      throw new Error("Missing pickup_location");
    }
    
    console.log("FINAL DELHIVERY PAYLOAD", JSON.stringify(payload, null, 2));
    
    // Prepare request
    const params = new URLSearchParams();
    params.append("format", "json");
    params.append("data", JSON.stringify(payload));
    
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    
    const text = await res.text();
    console.log("Delhivery response:", text);
    
    if (!res.ok) {
      throw new Error(`Delhivery API error (${res.status}): ${text}`);
    }
    
    let json;
    try {
      json = JSON.parse(text);
    } catch (parseError) {
      console.error("Failed to parse Delhivery response:", parseError);
      return { raw: text };
    }
    
    // Check for errors in response
    if (json?.success === false || json?.error) {
      const errorMsg = json?.rmk || json?.error || "Delhivery shipment creation failed";
      throw new Error(errorMsg);
    }
    
    // Extract waybill if available
    if (json?.packages?.[0]?.waybill) {
      json.waybill = json.packages[0].waybill;
    }
    
    return json;
    
  } catch (err) {
    console.error("Error in createShipment:", err);
    throw err;
  }
};

/**
 * Track a shipment
 */
export const trackShipment = async (waybill) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured");
  }
  
  if (!waybill) {
    throw new Error("Waybill number is required");
  }
  
  const url = `${b}/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`;
  console.log("Tracking shipment:", url);
  
  try {
    const res = await fetch(url, { headers: authHeader() });
    
    if (!res.ok) {
      throw new Error(`Delhivery tracking API error: ${res.status}`);
    }
    
    const data = await res.json();
    console.log("Tracking response:", data);
    
    // Format tracking response
    return formatTrackingResponse(data, waybill);
  } catch (err) {
    console.error("Error tracking shipment:", err);
    throw err;
  }
};

/**
 * Format tracking response
 */
const formatTrackingResponse = (data, waybill) => {
  if (data?.ShipmentData?.Shipment?.[0]) {
    const shipment = data.ShipmentData.Shipment[0];
    const status = shipment.Status?.Status?.[0] || {};
    
    return {
      waybill: waybill,
      status: status.Status || 'Unknown',
      statusCode: status.StatusCode || null,
      timestamp: status.StatusDateTime || null,
      location: status.StatusLocation || null,
      shipments: data.ShipmentData.Shipment,
      raw: data
    };
  }
  
  return {
    waybill: waybill,
    status: 'Not Found',
    raw: data
  };
};

/**
 * Generate shipping label
 */
export const generateLabel = async (waybills) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured");
  }
  
  const waybillArray = Array.isArray(waybills) ? waybills : [waybills];
  if (waybillArray.length === 0) {
    throw new Error("At least one waybill is required");
  }
  
  const url = `${b}/api/p/packing-slip`;
  console.log("Generating label for waybills:", waybillArray);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ waybills: waybillArray })
    });
    
    if (!res.ok) {
      throw new Error(`Delhivery label generation API error: ${res.status}`);
    }
    
    const data = await res.json();
    console.log("Label generation response:", data);
    
    return {
      success: true,
      waybills: waybillArray,
      data: data
    };
  } catch (err) {
    console.error("Error generating label:", err);
    throw err;
  }
};

/**
 * Cancel a shipment
 */
export const cancelShipment = async (waybill) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured");
  }
  
  if (!waybill) {
    throw new Error("Waybill number is required");
  }
  
  const url = `${b}/api/p/cancel`;
  console.log("Cancelling shipment:", waybill);
  
  try {
    const params = new URLSearchParams();
    params.append("waybill", waybill);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    if (!res.ok) {
      throw new Error(`Delhivery cancellation API error: ${res.status}`);
    }
    
    const data = await res.json();
    console.log("Cancellation response:", data);
    
    return {
      success: data?.success === true,
      waybill: waybill,
      message: data?.rmk || data?.message || "Shipment cancelled",
      data: data
    };
  } catch (err) {
    console.error("Error cancelling shipment:", err);
    throw err;
  }
};

/**
 * Get pickup time slots
 */
export const getPickupTimeSlots = async (pickupLocation) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured");
  }
  
  const url = `${b}/api/p/get_pickup_time_slots`;
  console.log("Getting pickup time slots for:", pickupLocation);
  
  try {
    const params = new URLSearchParams();
    params.append("pickup_location", pickupLocation);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    if (!res.ok) {
      throw new Error(`Delhivery pickup time API error: ${res.status}`);
    }
    
    const data = await res.json();
    console.log("Pickup time slots response:", data);
    
    return {
      success: data?.success === true,
      timeSlots: data?.time_slots || [],
      data: data
    };
  } catch (err) {
    console.error("Error getting pickup time slots:", err);
    throw err;
  }
};

/**
 * Validate pincode format
 */
export const validatePincode = (pincode) => {
  const pincodeStr = String(pincode).trim();
  return /^[1-9][0-9]{5}$/.test(pincodeStr);
};

/**
 * Register a client warehouse (pickup location) in Delhivery
 */
export const createWarehouse = async (pickupLocation) => {
  const b = base();
  if (!b || !token()) {
    throw new Error("Delhivery not configured. Please set DELHIVERY_BASE_URL and DELHIVERY_API_TOKEN");
  }

  const url = `${b}/api/backend/clientwarehouse/create/`;
  console.log("Registering Delhivery warehouse:", url);

  try {
    const payload = {
      name: String(pickupLocation.name || "").trim(),
      pin: String(pickupLocation.pin || "").trim(),
      phone: String(pickupLocation.phone || "").replace(/\D/g, "").slice(-10),
      address: String(pickupLocation.add || "").trim(),
      city: String(pickupLocation.city || "").trim(),
      state: String(pickupLocation.state || "").trim(),
      country: "India",
      return_address: String(pickupLocation.add || "").trim(),
      return_pin: String(pickupLocation.pin || "").trim()
    };

    console.log("Registering Delhivery warehouse payload:", JSON.stringify(payload, null, 2));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeader(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    console.log("Delhivery warehouse register response:", text);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return json;
  } catch (error) {
    console.error("Error in createWarehouse:", error);
    throw error;
  }
};

export const isDelhiveryConfigured = () => {
  return !!base() && !!token();
};

export default {
  checkServiceability,
  calculateShippingCost,
  createShipment,
  trackShipment,
  generateLabel,
  cancelShipment,
  getPickupTimeSlots,
  validatePincode,
  isDelhiveryConfigured,
  createWarehouse
};