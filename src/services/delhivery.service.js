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
    
    // Handle Delhivery API as per docs
    // Docs: If empty list → non-serviceable (NSZ)
    // If remark is "Embargo" → temporary NSZ
    // Else serviceable
    if (data?.success === false) {
      console.log("Delhivery API error:", data);
    } 
    // Check if delivery_codes exists and is array
    else if (data?.delivery_codes && Array.isArray(data.delivery_codes)) {
      if (data.delivery_codes.length === 0) {
        // Empty list → non-serviceable
        console.log("Delhivery: Empty delivery_codes list → NSZ (non-serviceable)");
        delivery_available = false;
        cod_available = false;
      } else {
        const postalCodes = data.delivery_codes.map(dc => dc?.postal_code).filter(Boolean);
        if (postalCodes.length > 0) {
          // Check each postal code
          for (const pc of postalCodes) {
            // If remark is "Embargo" → skip (non-serviceable)
            if (pc?.remark === "Embargo") {
              console.log("Delhivery: Pincode has Embargo remark → temporary NSZ");
              continue;
            }
            // If we get here, it's serviceable!
            delivery_available = true;
            // Check if COD is available
            if (pc?.cod === true || pc?.cod === "true") {
              cod_available = true;
            }
          }
        }
      }
    } 
    // If delivery_codes is an object (non-array)
    else if (data?.delivery_codes?.postal_code) {
      const pc = data.delivery_codes.postal_code;
      if (pc?.remark !== "Embargo") {
        delivery_available = true;
        cod_available = pc?.cod === true || pc?.cod === "true";
      }
    }
    // If unrecognized format, use fallback
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

  // Use the CMU create endpoint (no /c prefix)
  const url = `${b}/api/cmu/create.json`;
  console.log("Delhivery API URL:", url);

  try {
    let payload = shipmentData;
    // unwrap if caller passed { format, data: { shipments: [...] } }
    if (shipmentData && shipmentData.data && shipmentData.data.shipments) {
      payload = shipmentData.data;
    }

    // Payload cleanup to satisfy Delhivery business validations:
    // - remove empty ewaybill fields
    // - remove ewaybill_no / seller_gst_tin when not present
    // - remove shipping_mode if present
    // - recalculate total_amount from products
    // - set order_date to current date only
    if (payload && Array.isArray(payload.shipments) && payload.shipments[0]) {
      const s = payload.shipments[0];
      // delete empty ewaybill fields
      if (s.hasOwnProperty('ewaybill_date')) delete s.ewaybill_date;
      if (s.hasOwnProperty('ewaybill_validity')) delete s.ewaybill_validity;

      // delete ewaybill_no if falsy
      if (!s.ewaybill_no) delete s.ewaybill_no;

      // delete seller_gst_tin if falsy
      if (!s.seller_gst_tin) delete s.seller_gst_tin;

      // delete shipping_mode if present
      if (s.hasOwnProperty('shipping_mode')) delete s.shipping_mode;

      // delete ewaybill_value if present
      delete s.ewaybill_value;

      // recalculate total_amount only if missing or invalid
      if (
        !s.total_amount ||
        Number(s.total_amount) <= 0
      ) {
        if (Array.isArray(s.products)) {
          s.total_amount = s.products.reduce(
            (a, p) =>
              a +
              (Number(p.selling_price) * Number(p.qty || 1)),
            0
          );
        }
      }

      // remove any empty-string, null or undefined fields to avoid Delhivery validation crashes
      Object.keys(s).forEach((k) => {
        if (s[k] === "" || s[k] === null || s[k] === undefined) {
          delete s[k];
        }
      });

      // remove products array before sending to Delhivery
      delete s.products;

      // ensure order_date is set to current date only (YYYY-MM-DD) for Delhivery validation
      if (!s.order_date) {
        s.order_date = new Date().toISOString().slice(0, 10);
      }
    }

    // Log pickup location for exact name verification in Delhivery panel
    console.log('pickup_location exact:', payload?.pickup_location);

    console.log("Sending to Delhivery shipment data:", JSON.stringify(payload, null, 2));

    const params = new URLSearchParams();
    params.append('format', 'json');
    params.append('data', JSON.stringify(payload));

    console.log('Form body (preview):', params.toString().substring(0, 200));

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    console.log('Delhivery response status:', res.status, res.statusText);
    const text = await res.text();
    console.log('Delhivery response body:', text);

    if (!res.ok) {
      console.error('Delhivery error response body:', text);
      throw new Error(`Delhivery API error: ${res.status} ${res.statusText} - ${text}`);
    }

    if (!text) return {};

    try {
      const json = JSON.parse(text);
      if (json?.success === false) {
        throw new Error(json?.rmk || "Delhivery rejected shipment");
      }
      return json;
    } catch (e) {
      // If parsing failed, return raw body; otherwise rethrow the error
      if (e instanceof SyntaxError) {
        return { raw: text };
      }
      throw e;
    }
  } catch (err) {
    console.error('Error in createShipment:', err);
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
