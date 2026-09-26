import { generateCode128Svg } from "./code128.js";

/**
 * Generate official, high-resolution Delhivery Shipping Label HTML matching standard Delhivery A6 / 4x6 inch format.
 */
export function renderDelhiveryShippingLabelHtml({ order, waybill, packageData = {}, store = {} }) {
  const wbn = String(waybill || packageData.waybill || order.shipping?.waybill || "").trim();
  const orderNumber = String(order.orderNumber || order._id.toString().slice(-8).toUpperCase()).trim();
  
  // Consignee (Customer)
  const custName = packageData.consignee?.name || packageData.cnee || order.customer?.name || "Customer";
  const custPhone = packageData.consignee?.phone || order.customer?.phone || "";
  const custAddress1 = packageData.consignee?.address || packageData.cnee_add || order.shippingAddress?.line1 || "";
  const custAddress2 = order.shippingAddress?.line2 || "";
  const custCity = packageData.consignee?.city || packageData.city || order.shippingAddress?.city || "";
  const custState = packageData.consignee?.state || packageData.state || order.shippingAddress?.state || "";
  const custPincode = packageData.consignee?.pin || packageData.pin || order.shippingAddress?.pincode || "";

  // Shipper / Seller
  const sellerName = store.name || store.pickupName || "SmartOdisha Seller Partner";
  const sellerPhone = store.pickupPhone || store.phone || "";
  const sellerAddress = store.pickupAddress?.addressLine1 || store.address || "Hub Center";
  const sellerCity = store.pickupAddress?.city || "Odisha";
  const sellerPincode = store.pickupAddress?.pincode || "";
  const sellerGstin = store.gstin || "N/A";

  // Routing & Logistics
  const sortCode = packageData.sort_code || packageData.routing_code || `${custCity.slice(0,3).toUpperCase()}/EXP`;
  const isCod = order.paymentMethod === "COD" || packageData.is_cod === true || packageData.ptype === "COD";
  const payableAmount = isCod ? (order.codDueAmount || order.totalEstimate || 0) : 0;
  const declaredValue = order.totalEstimate || 0;

  // Barcodes (Code 128)
  const waybillBarcodeSvg = generateCode128Svg(wbn, { height: 60, barWidth: 2, showText: true });
  const orderBarcodeSvg = generateCode128Svg(orderNumber, { height: 42, barWidth: 2, showText: true });

  // Items List
  const items = Array.isArray(order.items) && order.items.length > 0 ? order.items : [
    { name: packageData.product_desc || "General Merchandise", quantity: 1, price: declaredValue }
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Delhivery Shipping Label - ${wbn}</title>
  <style>
    @page {
      size: 100mm 150mm;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: Arial, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      background: #f1f5f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px 10px;
      color: #000;
    }
    .print-actions {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .print-btn {
      background: #e11d48;
      color: #fff;
      border: none;
      padding: 10px 24px;
      font-size: 14px;
      font-weight: bold;
      border-radius: 8px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(225, 29, 72, 0.25);
    }
    .print-btn:hover {
      background: #be123c;
    }
    .label-card {
      width: 100mm;
      min-height: 148mm;
      background: #fff;
      border: 2px solid #000;
      padding: 6px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      font-size: 11px;
      line-height: 1.25;
      display: flex;
      flex-direction: column;
    }
    .header-row {
      display: flex;
      border-bottom: 2px solid #000;
      padding-bottom: 4px;
      align-items: center;
      justify-content: space-between;
    }
    .delhivery-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .delhivery-logo-box {
      background: #231f20;
      color: #fff;
      padding: 4px 6px;
      font-weight: 900;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-radius: 2px;
      text-transform: uppercase;
    }
    .delhivery-logo-box span {
      color: #e11d48;
    }
    .delhivery-wordmark {
      font-size: 22px;
      font-weight: 900;
      letter-spacing: 1px;
      color: #231f20;
    }
    .delhivery-wordmark span {
      color: #e11d48;
    }
    .barcode-section {
      padding: 8px 4px 4px;
      text-align: center;
      border-bottom: 2px solid #000;
    }
    .routing-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 6px;
      font-weight: 900;
      font-size: 15px;
      border-bottom: 2px solid #000;
    }
    .mid-section {
      display: flex;
      border-bottom: 2px solid #000;
      min-height: 72px;
    }
    .address-box {
      flex: 1.5;
      padding: 6px;
      border-right: 2px solid #000;
    }
    .address-title {
      font-size: 10px;
      font-weight: bold;
      color: #333;
      margin-bottom: 2px;
      text-transform: uppercase;
    }
    .consignee-name {
      font-size: 12px;
      font-weight: 900;
      margin-bottom: 2px;
    }
    .payment-box {
      flex: 1;
      padding: 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      background: #fafafa;
    }
    .payment-type {
      font-size: 16px;
      font-weight: 900;
      letter-spacing: 0.5px;
    }
    .payment-amount {
      font-size: 15px;
      font-weight: 900;
      margin: 2px 0;
      color: #000;
    }
    .express-tag {
      font-size: 11px;
      font-weight: bold;
      margin-top: 2px;
    }
    .seller-row {
      padding: 5px 6px;
      border-bottom: 2px solid #000;
      font-size: 10px;
      display: flex;
      justify-content: space-between;
    }
    .seller-row b {
      font-size: 11px;
    }
    .items-table {
      width: 100%;
      border-collapse: collapse;
      border-bottom: 2px solid #000;
      font-size: 9px;
    }
    .items-table th {
      border-bottom: 1px solid #000;
      padding: 3px 4px;
      text-align: left;
      font-weight: bold;
      background: #f8fafc;
    }
    .items-table td {
      padding: 3px 4px;
      vertical-align: top;
    }
    .items-table tr:not(:last-child) td {
      border-bottom: 1px dashed #ccc;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 6px;
      font-weight: 900;
      font-size: 11px;
      border-bottom: 2px solid #000;
    }
    .secondary-barcode {
      padding: 6px 4px;
      text-align: center;
      border-bottom: 2px solid #000;
    }
    .return-address-row {
      padding: 4px 6px;
      font-size: 9px;
      color: #333;
    }
    @media print {
      body {
        background: transparent;
        padding: 0;
      }
      .print-actions {
        display: none;
      }
      .label-card {
        box-shadow: none;
        border: 2px solid #000;
        page-break-inside: avoid;
        margin: 0;
        width: 100%;
      }
    }
  </style>
</head>
<body>

  <div class="print-actions">
    <button class="print-btn" onclick="window.print()">🖨️ Print Shipping Label</button>
  </div>

  <div class="label-card">
    <!-- Top Header -->
    <div class="header-row">
      <div class="delhivery-brand">
        <div class="delhivery-logo-box">DELHI<span>V</span>ERY</div>
        <div class="delhivery-wordmark">DELHI<span>V</span>ERY</div>
      </div>
      <div style="font-size: 10px; font-weight: bold; text-align: right;">
        AIR EXPRESS
      </div>
    </div>

    <!-- Main Waybill Barcode -->
    <div class="barcode-section">
      ${waybillBarcodeSvg}
    </div>

    <!-- Pincode and Sort Code -->
    <div class="routing-row">
      <div>PIN: ${custPincode}</div>
      <div>${sortCode}</div>
    </div>

    <!-- Middle Section: Address & Payment Mode -->
    <div class="mid-section">
      <div class="address-box">
        <div class="address-title">Shipping Address:</div>
        <div class="consignee-name">${custName}</div>
        <div>${custAddress1}</div>
        ${custAddress2 ? `<div>${custAddress2}</div>` : ""}
        <div>${custCity}, ${custState}</div>
        <div><b>PIN: ${custPincode}</b></div>
        ${custPhone ? `<div>Phone: ${custPhone}</div>` : ""}
      </div>
      <div class="payment-box">
        <div class="payment-type">${isCod ? "COD" : "PREPAID"}</div>
        <div class="payment-amount">${isCod ? `₹${payableAmount}` : "₹0.00"}</div>
        <div class="express-tag">Express</div>
      </div>
    </div>

    <!-- Seller / Consignor Info -->
    <div class="seller-row">
      <div>
        <div><b>Seller:</b> ${sellerName}</div>
        <div>${sellerAddress}, ${sellerCity} - ${sellerPincode}</div>
      </div>
      <div style="text-align: right;">
        ${sellerGstin !== "N/A" ? `<div>GSTIN: ${sellerGstin}</div>` : ""}
        <div>Order: #${orderNumber}</div>
      </div>
    </div>

    <!-- Items Table -->
    <table class="items-table">
      <thead>
        <tr>
          <th>Product</th>
          <th style="text-align: center; width: 40px;">Qty</th>
          <th style="text-align: right; width: 60px;">Price</th>
          <th style="text-align: right; width: 60px;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(it => `
          <tr>
            <td>${it.name || "Item"} ${it.variantSku ? `(${it.variantSku})` : ""}</td>
            <td style="text-align: center;">${it.quantity || 1}</td>
            <td style="text-align: right;">₹${Number(it.price || 0).toLocaleString("en-IN")}</td>
            <td style="text-align: right;">₹${Number((it.price || 0) * (it.quantity || 1)).toLocaleString("en-IN")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <!-- Total -->
    <div class="total-row">
      <div>Total Items: ${items.reduce((s, it) => s + (it.quantity || 1), 0)}</div>
      <div>Total Value: ₹${Number(declaredValue).toLocaleString("en-IN")}</div>
    </div>

    <!-- Secondary Barcode (Order Number) -->
    <div class="secondary-barcode">
      ${orderBarcodeSvg}
    </div>

    <!-- Return Address -->
    <div class="return-address-row">
      <b>Return Address:</b> ${sellerName}, ${sellerAddress}, ${sellerCity} - ${sellerPincode} ${sellerPhone ? `| Ph: ${sellerPhone}` : ""}
    </div>
  </div>

  <script>
    // Automatically trigger print preview when loaded in a new tab
    window.addEventListener('load', () => {
      setTimeout(() => {
        try { window.print(); } catch (e) {}
      }, 350);
    });
  </script>
</body>
</html>`;
}
