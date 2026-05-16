import PDFDocument from "pdfkit";
import path from "path";

export const streamInvoicePDF = (res, bill, customer) => {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=${bill.invoiceNumber}.pdf`);
  doc.pipe(res);

  const companyName = process.env.COMPANY_NAME || "Click2Kart";
  const companyGst = process.env.COMPANY_GST || "27ABCDE1234F1Z5";
  const companyAddress = process.env.COMPANY_ADDRESS || "Shop No. 12, Main Market, Mumbai - 400001";
  const companyPhone = process.env.COMPANY_PHONE || "+91 98765 43210";
  const companyEmail = process.env.COMPANY_EMAIL || "support@click2kart.net";
  const companyLogo = process.env.COMPANY_LOGO || path.resolve("assets", "logo.png");

  try {
    doc.image(companyLogo, 50, 40, { fit: [140, 40] });
  } catch {}
  doc.fillColor("#7c3aed").rect(50, 90, 495, 3).fill();
  doc.fillColor("#1e293b").fontSize(20).text(companyName, 50, 100);
  doc.fillColor("#64748b").fontSize(9).text(companyAddress);
  doc.text(`Phone: ${companyPhone} | Email: ${companyEmail}`);
  if (companyGst) doc.text(`GSTIN: ${companyGst}`);
  
  doc.moveTo(50, 115).lineTo(545, 115).strokeColor("#cbd5e1").lineWidth(1).stroke();

  // --- Invoice Info & Bill To ---
  doc.moveDown(2);
  const topInfo = 130;
  
  // Bill To (Left)
  doc.fillColor("#1e293b").fontSize(10).text("BILL TO:", 50, topInfo, { underline: true });
  doc.fontSize(12).text(customer.name, 50, topInfo + 15);
  doc.fillColor("#64748b").fontSize(10);
  if (customer.phone) doc.text(`Phone: ${customer.phone}`, 50, topInfo + 32);
  if (customer.address) doc.text(customer.address, 50, topInfo + 47, { width: 200 });

  // Invoice Details (Right)
  doc.fillColor("#1e293b").fontSize(10).text("INVOICE DETAILS:", 350, topInfo, { underline: true });
  doc.fontSize(10).text(`Invoice No:`, 350, topInfo + 15);
  doc.fillColor("#0f172a").text(bill.invoiceNumber, 430, topInfo + 15);
  doc.fillColor("#64748b").text(`Date:`, 350, topInfo + 30);
  doc.fillColor("#0f172a").text(new Date(bill.date).toLocaleDateString('en-IN'), 430, topInfo + 30);
  doc.fillColor("#64748b").text(`Payment:`, 350, topInfo + 45);
  doc.fillColor("#0f172a").text(bill.paymentType, 430, topInfo + 45);

  const tableTop = 230;
  doc.rect(50, tableTop, 495, 25).fill("#ede9fe");
  doc.fillColor("#4c1d95").fontSize(9);
  doc.text("SR.", 60, tableTop + 8);
  doc.text("ITEM DESCRIPTION", 90, tableTop + 8);
  doc.text("QTY", 300, tableTop + 8);
  doc.text("PRICE", 350, tableTop + 8);
  doc.text("GST %", 410, tableTop + 8);
  doc.text("AMOUNT", 480, tableTop + 8);

  let rowY = tableTop + 35;
  doc.fillColor("#1e293b").fontSize(10);
  
  bill.items.forEach((it, idx) => {
    if (rowY > 700) {
      doc.addPage();
      rowY = 50;
    }

    doc.text(idx + 1, 60, rowY);
    doc.text(it.name, 90, rowY, { width: 200 });
    doc.text(it.quantity, 300, rowY);
    doc.text(`₹${it.price.toFixed(2)}`, 350, rowY);
    doc.text(`${it.gst}%`, 410, rowY);
    doc.text(`₹${it.lineTotal.toFixed(2)}`, 480, rowY);
    
    rowY += 25;
    doc.moveTo(50, rowY - 5).lineTo(545, rowY - 5).strokeColor("#f1f5f9").lineWidth(0.5).stroke();
  });

  const totalsTop = Math.max(rowY + 20, 400);
  const totalsX = 350;

  doc.fillColor("#64748b").fontSize(10).text("Subtotal:", totalsX, totalsTop);
  doc.fillColor("#1e293b").text(`₹${bill.subtotal.toFixed(2)}`, 480, totalsTop);

  doc.fillColor("#64748b").text("GST Total:", totalsX, totalsTop + 20);
  doc.fillColor("#1e293b").text(`₹${bill.gstTotal.toFixed(2)}`, 480, totalsTop + 20);

  if (bill.discount > 0) {
    doc.fillColor("#ef4444").text(`Discount ${bill.couponCode ? `(${bill.couponCode})` : ""}:`, totalsX, totalsTop + 40);
    doc.text(`- ₹${bill.discount.toFixed(2)}`, 480, totalsTop + 40);
  }

  const finalTotalY = totalsTop + (bill.discount > 0 ? 70 : 50);
  doc.rect(totalsX - 10, finalTotalY - 10, 205, 35).fill("#ede9fe");
  doc.fillColor("#4c1d95").fontSize(12).text("GRAND TOTAL:", totalsX, finalTotalY);
  doc.fillColor("#0f172a").fontSize(14).text(`₹${bill.payable.toFixed(2)}`, 460, finalTotalY);

  doc.fillColor("#94a3b8").fontSize(8).text(
    "Thank you for shopping with us! This is a computer-generated invoice.",
    50,
    780,
    { align: "center", width: 495 }
  );

  doc.end();
};
