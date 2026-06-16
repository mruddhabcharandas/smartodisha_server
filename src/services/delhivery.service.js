import fetch from 'node-fetch';

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const base = () => _sanitize(process.env.DELHIVERY_BASE_URL || "https://staging-express.delhivery.com");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

/**
 * Check serviceability for a pincode
 */
export const checkServiceability = async (pincode) => {
  const b = base();
  if (!b) {
    console.log("Delhivery not configured, using fallback");
    return {
      pincode,
      delivery_available: true,
      cod_available: true,
      eta: 3
    };
  }

  try {
    const url = `${b}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
    console.log("Checking serviceability at:", url);
    const res = await fetch(url, { headers: authHeader() });
    console.log("Delhivery serviceability status:", res.status, res.statusText);
    
    const text = await res.text();
    console.log("Delhivery serviceability response body:", text);
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      console.error("Failed to parse Delhivery serviceability JSON:", jsonErr);
      // Fallback
      return {
        pincode,
        delivery_available: true,
        cod_available: true,
        eta: 3
      };
    }
    
    console.log("Delhivery serviceability data:", data);
    
    let delivery_available = false;
    let cod_available = false;
    
    // Handle Delhivery's various response formats
    if (data?.success === false) {
      console.log("Delhivery API error:", data);
    } 
    // Common format: { delivery_codes: [ { postal_code: { cod: true/false } } ] }
    else if (data?.delivery_codes && Array.isArray(data.delivery_codes)) {
      const postalCodes = data.delivery_codes.map(dc => dc?.postal_code).filter(Boolean);
      if (postalCodes.length > 0) {
        delivery_available = true;
        cod_available = postalCodes.some(pc => pc?.cod === true || pc?.cod === "true");
      }
    } 
    // Some versions have { delivery_codes: { postal_code: { cod: ... } } }
    else if (data?.delivery_codes?.postal_code) {
      delivery_available = true;
      cod_available = !!data.delivery_codes.postal_code.cod;
    }
    // Another format: just an array
    else if (Array.isArray(data) && data.length > 0) {
      delivery_available = true;
      cod_available = true;
    }
    // If API returns empty or unrecognized, use fallback
    else {
      console.log("Unrecognized Delhivery serviceability response, using fallback");
      delivery_available = true;
      cod_available = true;
    }

    return {
      pincode,
      delivery_available,
      cod_available,
      eta: 3
    };
  } catch (err) {
    console.error("Delhivery serviceability check failed, using fallback:", err);
    // Fallback: return available for now
    return {
      pincode,
      delivery_available: true,
      cod_available: true,
      eta: 3
    };
  }
};

/**
 * Calculate shipping cost (using Delhivery's rate calculator or fallback)
 */
export const calculateShippingCost = async ({ origin, destination, weight, orderAmount, paymentMethod }) => {
  try {
    // Try to use Delhivery's rate API if available, else use fallback
    const b = base();
    if (!b) throw new Error("delhivery_not_configured");

    // Fallback calculation (can be enhanced with Delhivery's actual rate API)
    const weightKg = Math.max(0.5, weight || 0.5);
    let baseRate = Number(process.env.DELHIVERY_BASE_RATE || 85);
    let perKgRate = Number(process.env.DELHIVERY_PER_KG_RATE || 0);

    let shippingCharge = baseRate + (perKgRate * (weightKg - 0.5));
    
    // Free delivery if order amount exceeds threshold
    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
    const isFreeDelivery = paymentMethod !== 'cod' && orderAmount >= freeDeliveryAbove;
    shippingCharge = isFreeDelivery ? 0 : shippingCharge;

    // COD charge: 5% or min ₹40, max ₹100
    const codCharge = paymentMethod === 'cod' 
      ? Math.min(Math.max(Math.round(orderAmount * 0.05), 40), 100) 
      : 0;

    return {
      deliveryCharge: shippingCharge,
      codCharge,
      finalCharge: shippingCharge + codCharge,
      codAvailable: true,
      codLimit: Number(process.env.COD_MAX_LIMIT || 20000),
      isFreeDelivery,
      selectedCourier: 'Delhivery',
      baseAmt: baseRate,
      weight: weightKg
    };
  } catch (error) {
    console.error("Delhivery shipping calculation failed, using fallback:", error);
    // Fallback calculation
    const weightKg = Math.max(0.5, weight || 0.5);
    const baseRate = Number(process.env.SHIPPING_BASE_CHARGE || 85);
    const perKgRate = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
    const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
    let shippingCharge = Math.max(minCharge, baseRate + (perKgRate * (weightKg - 0.5)));
    
    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
    const isFreeDelivery = paymentMethod !== 'cod' && orderAmount >= freeDeliveryAbove;
    shippingCharge = isFreeDelivery ? 0 : shippingCharge;
    
    const codCharge = paymentMethod === 'cod' 
      ? Math.min(Math.max(Math.round(orderAmount * 0.05), 40), 100) 
      : 0;

    return {
      deliveryCharge: shippingCharge,
      codCharge,
      finalCharge: shippingCharge + codCharge,
      codAvailable: true,
      codLimit: Number(process.env.COD_MAX_LIMIT || 20000),
      isFreeDelivery,
      selectedCourier: 'Delhivery',
      baseAmt: baseRate,
      weight: weightKg
    };
  }
};

/**
 * Create a shipment in Delhivery
 */
export const createShipment = async (shipmentData) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const url = `${b}/c/api/cmu/create.json`;
  console.log("Delhivery API URL:", url);
  
  try {
    // Extract actual payload (remove double-wrapping if present)
    let payload = shipmentData;
    if (shipmentData?.data?.shipments) {
      payload = shipmentData.data; // Use nested data if double-wrapped
    }
    
    console.log("Sending to Delhivery shipment data:", JSON.stringify(payload, null, 2));
    
    // Delhivery expects: application/x-www-form-urlencoded with format=json&data={...}
    const params = new URLSearchParams();
    params.append('format', 'json');
    params.append('data', JSON.stringify(payload));
    
    console.log("Form body:", params.toString().substring(0, 200)); // Log first 200 chars of body
    
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    console.log("Delhivery response status:", res.status, res.statusText);
    
    // Read response text only once
    const text = await res.text();
    console.log("Delhivery response body:", text);
    
    // Check if response is ok
    if (!res.ok) {
      console.error("Delhivery error response body:", text);
      throw new Error(`Delhivery API error: ${res.status} ${res.statusText} - ${text}`);
    }

    // Try to parse json
    try {
      return JSON.parse(text);
    } catch (jsonErr) {
      throw new Error(`Failed to parse Delhivery JSON response: ${jsonErr.message} - Response text: ${text}`);
    }
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
  if (!b) throw new Error("delhivery_not_configured");
  const url = `${b}/api/v1/packages/json/?waybill=${waybill}`;
  const res = await fetch(url, { headers: authHeader() });
  return await res.json();
};

/**
 * Generate shipping label
 */
export const generateLabel = async (waybills) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const url = `${b}/api/p/packing-slip`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ waybills: Array.isArray(waybills) ? waybills : [waybills] })
  });
  return await res.json();
};
