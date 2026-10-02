import axios from 'axios';

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
export const calculateShippingCost = async ({ origin, destination, weight, orderAmount, paymentMethod, freeDeliveryAbove }) => {
  try {
    // Validate inputs
    const weightKg = Math.max(DEFAULT_WEIGHT, parseFloat(weight) || DEFAULT_WEIGHT);
    const orderAmt = parseFloat(orderAmount) || 0;
    const payment = String(paymentMethod || "").toLowerCase();
    
    // Get configuration
    const baseRate = parseFloat(process.env.DELHIVERY_BASE_RATE) || DEFAULT_BASE_RATE;
    const perKgRate = parseFloat(process.env.DELHIVERY_PER_KG_RATE) || DEFAULT_PER_KG_RATE;
    const freeDeliveryAboveVal = typeof freeDeliveryAbove === 'number' ? freeDeliveryAbove : (parseFloat(process.env.FREE_DELIVERY_ABOVE) || DEFAULT_FREE_DELIVERY_ABOVE);
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
    const isFreeDelivery = payment !== 'cod' && orderAmt >= freeDeliveryAboveVal;
    const finalDeliveryCharge = isFreeDelivery ? 0 : shippingCharge;
    
    // COD charge: 5% or min ₹40, max ₹100
    let codCharge = 0;
    if (payment === 'cod') {
      codCharge = Math.min(Math.max(Math.round(orderAmt * 0.05), 40), 100);
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
    return getFallbackShippingCost({ weight, orderAmount, paymentMethod, freeDeliveryAbove });
  }
};

/**
 * Get fallback shipping cost
 */
const getFallbackShippingCost = ({ weight, orderAmount, paymentMethod, freeDeliveryAbove }) => {
  const weightKg = Math.max(DEFAULT_WEIGHT, parseFloat(weight) || DEFAULT_WEIGHT);
  const orderAmt = parseFloat(orderAmount) || 0;
  const payment = String(paymentMethod || "").toLowerCase();
  
  const baseRate = parseFloat(process.env.SHIPPING_BASE_CHARGE) || DEFAULT_BASE_RATE;
  const perKgRate = parseFloat(process.env.SHIPPING_PER_KG_CHARGE) || DEFAULT_PER_KG_RATE;
  const minCharge = parseFloat(process.env.SHIPPING_MIN_CHARGE) || DEFAULT_BASE_RATE;
  const freeDeliveryAboveVal = typeof freeDeliveryAbove === 'number' ? freeDeliveryAbove : (parseFloat(process.env.FREE_DELIVERY_ABOVE) || DEFAULT_FREE_DELIVERY_ABOVE);
  const codMaxLimit = parseFloat(process.env.COD_MAX_LIMIT) || DEFAULT_COD_MAX_LIMIT;
  
  let shippingCharge = Math.max(minCharge, baseRate + (perKgRate * (weightKg - DEFAULT_WEIGHT)));
  
  const isFreeDelivery = payment !== 'cod' && orderAmt >= freeDeliveryAboveVal;
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
 * Query Delhivery tracking API by client order ID
 */
export const getShipmentByOrderId = async (orderId) => {
  const b = base();
  if (!b || !token() || !orderId) return null;

  const cleanId = String(orderId).trim();
  const url = `${b}/api/v1/packages/json/?ref_ids=${encodeURIComponent(cleanId)}`;
  console.log("Querying Delhivery shipment by Order ID:", url);

  try {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) return null;

    const data = await res.json();
    let shipmentObj = null;

    if (Array.isArray(data?.ShipmentData) && data.ShipmentData.length > 0) {
      shipmentObj = data.ShipmentData[0]?.Shipment || data.ShipmentData[0];
    } else if (data?.ShipmentData?.Shipment) {
      shipmentObj = Array.isArray(data.ShipmentData.Shipment) ? data.ShipmentData.Shipment[0] : data.ShipmentData.Shipment;
    } else if (Array.isArray(data?.packages) && data.packages.length > 0) {
      shipmentObj = data.packages[0];
    } else if (data?.shipment) {
      shipmentObj = data.shipment;
    }

    const waybill = shipmentObj?.AWB || shipmentObj?.waybill || shipmentObj?.Waybill || shipmentObj?.wbn || null;
    if (waybill) {
      return {
        waybill: String(waybill).trim(),
        status: shipmentObj?.Status?.Status || shipmentObj?.Status || shipmentObj?.status || "Manifested",
        shipment: shipmentObj,
        raw: data
      };
    }
  } catch (err) {
    console.warn("getShipmentByOrderId error:", err.message);
  }
  return null;
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
    s.order_date = s.order_date || new Date().toISOString().slice(0, 10);
    s.weight = Number(s.weight || DEFAULT_WEIGHT);
    
    // Normalize payment mode and COD amount for Delhivery
    if (String(s.payment_mode || "").toUpperCase() === "COD") {
      s.payment_mode = "COD";
      const numCod = Number(s.cod_amount);
      if (!numCod || numCod <= 0) {
        s.cod_amount = Math.max(1, Number(s.total_amount) || 1);
      } else {
        s.cod_amount = numCod;
      }
    } else {
      s.payment_mode = "Pre-paid";
      delete s.cod_amount;
    }

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
    let pickupLocName = "";
    if (typeof payload.pickup_location === 'object' && payload.pickup_location?.name) {
      pickupLocName = String(payload.pickup_location.name).trim();
    } else {
      pickupLocName = String(payload.pickup_location || "").trim();
    }

    if (!pickupLocName) {
      throw new Error("Missing pickup_location");
    }

    payload.pickup_location = {
      name: pickupLocName
    };
    
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
    
    // 1. Extract waybill from standard response fields
    let waybill = json?.packages?.[0]?.waybill || json?.packages?.[0]?.wbn || json?.packages?.[0]?.awb || json?.upload_wbn || json?.shipments?.[0]?.waybill || "";

    // 2. Check for errors or duplicate in response
    const pkg = json?.packages?.[0];
    const isPackageFailed = pkg && (pkg.status === "Fail" || pkg.status === "Failed");
    const combinedRemarks = [
      json?.rmk,
      json?.error,
      pkg?.remarks ? (Array.isArray(pkg.remarks) ? pkg.remarks.join(" ") : String(pkg.remarks)) : ""
    ].filter(Boolean).join(" ");

    const isDuplicate = /already\s*exist|duplicate/i.test(combinedRemarks);

    if (!waybill && isDuplicate) {
      // Check if waybill is in remarks string
      const wbnMatch = combinedRemarks.match(/\b\d{12,14}\b/);
      if (wbnMatch) {
        waybill = wbnMatch[0];
      } else if (s.order) {
        // Query Delhivery tracking API by client order ID to fetch already-created waybill
        const existing = await getShipmentByOrderId(s.order);
        if (existing?.waybill) {
          waybill = existing.waybill;
        }
      }
    }

    if (waybill) {
      json.waybill = waybill;
      json.success = true;
      return json;
    }

    // Check for errors in response
    if (json?.success === false || json?.error || isPackageFailed) {
      const errorMsg = combinedRemarks || json?.rmk || json?.error || "Delhivery shipment creation failed";
      throw new Error(errorMsg);
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
  let shipmentObj = null;

  if (Array.isArray(data?.ShipmentData) && data.ShipmentData.length > 0) {
    shipmentObj = data.ShipmentData[0]?.Shipment || data.ShipmentData[0];
  } else if (data?.ShipmentData?.Shipment) {
    shipmentObj = Array.isArray(data.ShipmentData.Shipment) ? data.ShipmentData.Shipment[0] : data.ShipmentData.Shipment;
  } else if (Array.isArray(data?.packages) && data.packages.length > 0) {
    shipmentObj = data.packages[0];
  } else if (data?.shipment) {
    shipmentObj = data.shipment;
  }

  if (shipmentObj) {
    let rawStatus = "";
    let statusCode = null;
    let timestamp = null;
    let location = null;

    const statusField = shipmentObj.Status || shipmentObj.status;

    if (typeof statusField === "string") {
      rawStatus = statusField;
    } else if (statusField && typeof statusField === "object") {
      rawStatus = typeof statusField.Status === "string"
        ? statusField.Status
        : (typeof statusField.status === "string" ? statusField.status : (statusField.Instructions || statusField.StatusType || ""));
      statusCode = statusField.StatusCode || statusField.status_code || statusField.StatusType || null;
      timestamp = statusField.StatusDateTime || statusField.status_date_time || statusField.timestamp || null;
      location = statusField.StatusLocation || statusField.location || null;
    }

    if (!rawStatus && shipmentObj.CurrentStatus) {
      rawStatus = String(shipmentObj.CurrentStatus);
    }

    // Check latest scan if status is still empty
    if (!rawStatus && Array.isArray(shipmentObj.Scans) && shipmentObj.Scans.length > 0) {
      const latestScan = shipmentObj.Scans[shipmentObj.Scans.length - 1]?.ScanDetail || shipmentObj.Scans[shipmentObj.Scans.length - 1];
      rawStatus = latestScan?.Scan || latestScan?.Instructions || latestScan?.Status || "";
      timestamp = timestamp || latestScan?.ScanDateTime;
      location = location || latestScan?.ScannedLocation;
    }

    return {
      waybill,
      status: rawStatus || 'Unknown',
      statusCode,
      timestamp,
      location,
      shipment: shipmentObj,
      raw: data
    };
  }

  return {
    waybill: waybill,
    status: typeof data?.status === 'string' ? data.status : 'Not Found',
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
  
  const wbns = waybillArray.join(",");
  
  // Officially Delhivery API uses /api/p/packing_slip (try with &pdf=true first)
  const tryFetchLabel = async (withPdfParam = true) => {
    const url = `${b}/api/p/packing_slip?wbns=${wbns}${withPdfParam ? "&pdf=true" : ""}`;
    console.log("Generating Delhivery label from:", url);
    return axios.get(url, {
      headers: { ...authHeader() },
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
  };

  try {
    let res = await tryFetchLabel(true);
    if (res.status >= 400) {
      console.warn(`Delhivery packing slip API with pdf=true responded with status ${res.status}, retrying without &pdf=true`);
      res = await tryFetchLabel(false);
    }

    if (res.status >= 400) {
      const errText = Buffer.from(res.data).toString("utf8");
      console.warn(`Delhivery packing slip API error ${res.status}:`, errText);
      throw new Error(`Delhivery label generation API error: ${res.status}`);
    }

    const contentType = String(res.headers["content-type"] || "");
    const rawBuffer = Buffer.from(res.data);

    // Direct PDF from Delhivery
    if (contentType.includes("pdf") || rawBuffer.slice(0, 5).toString() === "%PDF-") {
      return {
        success: true,
        format: "pdf",
        pdfBuffer: rawBuffer
      };
    }

    // Try to parse JSON data
    try {
      const text = rawBuffer.toString("utf8");
      const json = JSON.parse(text);

      const pkg = json.packages?.[0] || json.package || {};
      const remotePdfUrl = json.pdf_download_link || json.pdfUrl || json.pdf_url || json.label_url || json.download_url ||
        pkg.pdf_download_link || pkg.pdf_url || pkg.label_url || pkg.download_url;

      if (remotePdfUrl && typeof remotePdfUrl === "string" && remotePdfUrl.startsWith("http")) {
        try {
          console.log("Downloading official Delhivery PDF from remote URL:", remotePdfUrl);
          const pdfFetch = await axios.get(remotePdfUrl, { responseType: "arraybuffer" });
          return {
            success: true,
            format: "pdf",
            pdfBuffer: Buffer.from(pdfFetch.data)
          };
        } catch (pdfErr) {
          console.warn("Failed to download remote PDF from Delhivery URL:", pdfErr.message);
        }
      }

      return {
        success: true,
        format: "json",
        data: json,
        packages: json.packages || []
      };
    } catch (parseErr) {
      return {
        success: true,
        format: "pdf",
        pdfBuffer: rawBuffer
      };
    }
  } catch (err) {
    console.error("Error generating label from Delhivery:", err.message);
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
  getShipmentByOrderId,
  trackShipment,
  generateLabel,
  cancelShipment,
  getPickupTimeSlots,
  validatePincode,
  isDelhiveryConfigured,
  createWarehouse
};