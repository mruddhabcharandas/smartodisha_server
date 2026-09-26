import PDFDocument from "pdfkit";
import { getCode128Modules } from "./code128.js";

/**
 * Draw scannable Code 128 vector barcode in PDFKit
 */
function drawBarcode(doc, text, x, y, width, height) {
  const modules = getCode128Modules(String(text || "").trim());
  if (!modules || modules.length === 0) return;
  const barWidth = width / modules.length;
  doc.save();
  doc.fillColor("#000000");
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === "1") {
      doc.rect(x + i * barWidth, y, barWidth, height).fill();
    }
  }
  doc.restore();
}

/**
 * Generate official Delhivery Shipping Label as a pure PDF buffer (4x6 / A6 standard thermal format).
 */
export async function generateDelhiveryPdfLabel({ order, waybill, packageData = {}, store = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const wbn = String(waybill || packageData.waybill || order.shipping?.waybill || "").trim();
      const orderNumber = String(order.orderNumber || (order._id ? order._id.toString().slice(-8).toUpperCase() : "ORD")).trim();

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

      // Logistics
      const sortCode = packageData.sort_code || packageData.routing_code || `${custCity.slice(0, 3).toUpperCase()}/EXP`;
      const isCod = order.paymentMethod === "COD" || packageData.is_cod === true || packageData.ptype === "COD";
      const payableAmount = isCod ? (order.codDueAmount || order.totalEstimate || 0) : 0;
      const declaredValue = order.totalEstimate || 0;

      // Standard A6 thermal label size in points (100mm x 150mm = 283.46 x 425.2)
      const doc = new PDFDocument({
        size: [283.46, 425.2],
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title: `Delhivery Shipping Label - ${wbn}`,
          Author: "Delhivery Logistics",
          Subject: "Shipping Label"
        }
      });

      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", err => reject(err));

      const left = 8;
      const top = 8;
      const width = 267.46;
      const height = 409.2;
      const right = left + width;

      // Outer border
      doc.lineWidth(1.5).strokeColor("#000000").rect(left, top, width, height).stroke();

      // Top Header
      doc.fillColor("#231f20").rect(left + 2, top + 2, 88, 22).fill();
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(12).text("DELHIVERY", left + 8, top + 7);
      // Air Express tag
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(10).text("AIR EXPRESS", left + 96, top + 8);
      // Routing code top right
      doc.font("Helvetica-Bold").fontSize(14).text(sortCode, left, top + 6, { width: width - 8, align: "right" });

      // Horizontal line below header
      let currentY = top + 26;
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Waybill Barcode section
      if (wbn) {
        drawBarcode(doc, wbn, left + 18, currentY + 6, width - 36, 40);
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000").text(wbn, left, currentY + 48, { width, align: "center" });
      }
      currentY += 64;

      // Horizontal line below waybill
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Pincode and routing row
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(13).text(`PIN: ${custPincode}`, left + 6, currentY + 4);
      doc.font("Helvetica-Bold").fontSize(13).text(sortCode, left, currentY + 4, { width: width - 12, align: "right" });
      currentY += 20;

      // Horizontal line below pincode
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Mid Section: Address (left) & Payment (right)
      const midHeight = 78;
      const splitX = left + 172;

      // Address on left
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#333333").text("SHIPPING ADDRESS:", left + 6, currentY + 4);
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#000000").text(custName.slice(0, 30), left + 6, currentY + 13);
      doc.font("Helvetica").fontSize(7.5).fillColor("#111111");
      let addrY = currentY + 24;
      if (custAddress1) { doc.text(custAddress1.slice(0, 38), left + 6, addrY); addrY += 9; }
      if (custAddress2) { doc.text(custAddress2.slice(0, 38), left + 6, addrY); addrY += 9; }
      doc.text(`${custCity}, ${custState} - ${custPincode}`, left + 6, addrY); addrY += 9;
      if (custPhone) { doc.font("Helvetica-Bold").text(`Ph: ${custPhone}`, left + 6, addrY); }

      // Vertical separator
      doc.lineWidth(1.5).moveTo(splitX, currentY).lineTo(splitX, currentY + midHeight).stroke();

      // Payment Box on right
      doc.fillColor("#fafafa").rect(splitX + 1, currentY + 1, right - splitX - 2, midHeight - 2).fill();
      doc.font("Helvetica-Bold").fontSize(15).fillColor(isCod ? "#dc2626" : "#059669")
        .text(isCod ? "COD" : "PREPAID", splitX, currentY + 12, { width: right - splitX, align: "center" });
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000")
        .text(isCod ? `₹${payableAmount}` : "₹0.00", splitX, currentY + 30, { width: right - splitX, align: "center" });
      doc.font("Helvetica").fontSize(8).fillColor("#555555")
        .text("Express Delivery", splitX, currentY + 48, { width: right - splitX, align: "center" });

      currentY += midHeight;
      // Horizontal line
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Seller Row
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#000000").text(`Seller: ${sellerName.slice(0, 26)}`, left + 6, currentY + 3);
      doc.font("Helvetica").fontSize(7).fillColor("#333333").text(`${sellerAddress.slice(0, 32)}, ${sellerCity} - ${sellerPincode}`, left + 6, currentY + 12);
      if (sellerGstin && sellerGstin !== "N/A") {
        doc.font("Helvetica").fontSize(7).text(`GSTIN: ${sellerGstin}`, left + 6, currentY + 21);
      }
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000").text(`Order: #${orderNumber}`, left, currentY + 3, { width: width - 12, align: "right" });
      doc.font("Helvetica").fontSize(7).text(`Val: ₹${Number(declaredValue).toLocaleString("en-IN")}`, left, currentY + 13, { width: width - 12, align: "right" });

      currentY += 30;
      // Horizontal line
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Items Table Header
      doc.fillColor("#f1f5f9").rect(left + 1, currentY + 1, width - 2, 13).fill();
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#000000");
      doc.text("ITEM", left + 6, currentY + 4);
      doc.text("QTY", left + 170, currentY + 4, { width: 30, align: "center" });
      doc.text("PRICE", left + 205, currentY + 4, { width: 50, align: "right" });

      currentY += 14;
      doc.lineWidth(0.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Items Rows
      const items = Array.isArray(order.items) && order.items.length > 0 ? order.items.slice(0, 3) : [
        { name: packageData.product_desc || "General Merchandise", quantity: 1, price: declaredValue }
      ];

      items.forEach(it => {
        doc.font("Helvetica").fontSize(7).fillColor("#111111");
        const itemName = `${it.name || "Item"}${it.variantSku ? ` (${it.variantSku})` : ""}`.slice(0, 32);
        doc.text(itemName, left + 6, currentY + 3);
        doc.text(String(it.quantity || 1), left + 170, currentY + 3, { width: 30, align: "center" });
        doc.text(`₹${Number(it.price || 0).toLocaleString("en-IN")}`, left + 205, currentY + 3, { width: 50, align: "right" });
        currentY += 12;
      });

      // Total row
      doc.lineWidth(1).moveTo(left, currentY).lineTo(right, currentY).stroke();
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#000000");
      doc.text(`Total Items: ${items.reduce((s, it) => s + (it.quantity || 1), 0)}`, left + 6, currentY + 3);
      doc.text(`Total Value: ₹${Number(declaredValue).toLocaleString("en-IN")}`, left, currentY + 3, { width: width - 12, align: "right" });
      currentY += 14;

      // Horizontal line
      doc.lineWidth(1.5).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Secondary Barcode (Order Number)
      if (orderNumber) {
        drawBarcode(doc, orderNumber, left + 45, currentY + 4, width - 90, 22);
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000").text(`*${orderNumber}*`, left, currentY + 28, { width, align: "center" });
      }
      currentY += 38;

      // Horizontal line
      doc.lineWidth(1).moveTo(left, currentY).lineTo(right, currentY).stroke();

      // Return Address
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#333333").text("Return Address:", left + 6, currentY + 3);
      doc.font("Helvetica").fontSize(6.5).text(`${sellerName}, ${sellerAddress}, ${sellerCity} - ${sellerPincode}${sellerPhone ? ` | Ph: ${sellerPhone}` : ""}`, left + 62, currentY + 3, { width: width - 70 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
