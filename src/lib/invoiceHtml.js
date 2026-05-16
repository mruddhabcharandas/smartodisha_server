import path from "path";

export const renderInvoiceHTML = (bill, customer, order, company = {}) => {
  const fmt = (n) => `₹${Number(n || 0).toFixed(2)}`;
  const cgstTotal = (bill.gstTotal || 0) / 2;
  const sgstTotal = (bill.gstTotal || 0) / 2;
  const amountWords = "Amount in words to be filled"; 

  const companyName = company.name || process.env.COMPANY_NAME || "Click2Kart Pvt Ltd";
  const companyAddress = company.address || process.env.COMPANY_ADDRESS || "Plot 21, Sector 18, Electronic City, Bengaluru 560100";
  const companyPhone = company.phone || process.env.COMPANY_PHONE || "+91 79788 80244";
  const companyEmail = company.email || process.env.COMPANY_EMAIL || "support@click2kart.net";
  const companyGst = company.gst || process.env.COMPANY_GST || "29ABCDE1234F1Z5";
  const logo = company.logo || process.env.COMPANY_LOGO || "click2kart-logo.png";

  const bank = {
    accName: process.env.COMPANY_BANK_ACCNAME || "Click2Kart Pvt Ltd",
    accNo: process.env.COMPANY_BANK_ACCNO || "123456789012",
    ifsc: process.env.COMPANY_BANK_IFSC || "HDFC0001234",
    bankName: process.env.COMPANY_BANK_NAME || "HDFC Bank, Indiranagar Branch"
  };

  const rows = (bill.items || []).map((it, idx) => {
    const cgstRate = (it.gst || 0) / 2;
    const sgstRate = (it.gst || 0) / 2;
    return `
      <tr>
        <td>${String(idx + 1).padStart(2, "0")}</td>
        <td>${it.name}</td>
        <td>${it.hsn || ""}</td>
        <td class="num">${it.quantity}</td>
        <td class="num">${fmt(it.price)}</td>
        <td class="num">${fmt(it.lineSubtotal)}</td>
        <td class="num">${cgstRate}%</td>
        <td class="num">${sgstRate}%</td>
        <td class="num">${fmt(it.lineTotal)}</td>
      </tr>
    `;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${companyName} | Tax Invoice</title>
<style>
  :root { --primary:#1e40af; --accent:#f97316; --text:#0f172a; --muted:#475569; --border:#e2e8f0; --bg:#ffffff; --row:#f8fafc; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
  .invoice { max-width:900px; margin:24px auto; padding:32px; border:1px solid var(--border); border-radius:16px; background:#fff; }
  .row { display:flex; gap:24px; } .col{flex:1} .right{text-align:right} .muted{color:var(--muted)}
  .badge{display:inline-block;padding:6px 12px;border-radius:999px;font:900 12px/1 ui-sans-serif;letter-spacing:.2em;text-transform:uppercase;background:rgba(30,64,175,.08);color:var(--primary);border:1px solid rgba(30,64,175,.18)}
  .divider{height:2px;background:linear-gradient(90deg,var(--primary),var(--accent));border-radius:2px;margin:16px 0 24px}
  .brand{display:flex;align-items:center;gap:16px} .brand img{height:48px;width:auto}
  .block{padding:16px;border:1px solid var(--border);border-radius:12px;background:#fff}
  .block h3{margin:0 0 8px;font:900 13px/1 ui-sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
  .kv{display:grid;grid-template-columns:160px 1fr;gap:8px 16px}.k{color:var(--muted);font-weight:700}.v{font-weight:800}
  table{width:100%;border-collapse:collapse;border:1px solid var(--border);border-radius:12px;overflow:hidden}
  thead th{background:var(--row);color:var(--muted);font:900 12px/1 ui-sans-serif;letter-spacing:.15em;text-transform:uppercase;padding:12px;border-bottom:1px solid var(--border);text-align:left}
  tbody td{padding:12px;border-bottom:1px solid var(--border);vertical-align:top} tbody tr:last-child td{border-bottom:0}
  .num{text-align:right;white-space:nowrap}
  .totals{margin-left:auto;max-width:380px}.totals .row{display:flex;justify-content:space-between;margin:6px 0}.label{color:var(--muted);font-weight:800}
  .grand{background:var(--row);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-top:8px;display:flex;justify-content:space-between;align-items:center}
  .grand .label{color:var(--primary);font:900 13px/1 ui-sans-serif;letter-spacing:.18em;text-transform:uppercase}
  .grand .value{font-size:20px;font-weight:900}
  .bank{display:grid;grid-template-columns:1fr 1fr;gap:16px}.stamp{height:120px;border:1px dashed var(--border);border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:800}
  .terms{font-size:12px;color:var(--muted)} .sig{height:64px;border-bottom:1px solid var(--border);margin-bottom:6px} .sig-lbl{font-size:12px;color:var(--muted)}
  .amount-words{font-size:12px;font-weight:800;border:1px dashed var(--border);border-radius:12px;padding:10px 12px;background:#fff}
</style></head>
<body>
  <div class="invoice">
    <div class="row" style="align-items:center;justify-content:space-between">
      <div class="brand">
        <img src="${logo}" alt="${companyName}">
        <div>
          <div style="font-size:22px;font-weight:900">${companyName}</div>
          <div class="muted">${companyAddress}</div>
          <div class="muted">${companyPhone} • ${companyEmail}</div>
          <div class="muted">GSTIN: ${companyGst}</div>
        </div>
      </div>
      <div class="right"><div class="badge">Tax Invoice</div></div>
    </div>
    <div class="divider"></div>
    <div class="row">
      <div class="col block">
        <h3>Invoice Details</h3>
        <div class="kv">
          <div class="k">Invoice No</div><div class="v">${bill.invoiceNumber}</div>
          <div class="k">Order ID</div><div class="v">${order?._id || ""}</div>
          <div class="k">Invoice Date</div><div class="v">${new Date(bill.date).toLocaleDateString("en-IN")}</div>
          <div class="k">Payment Mode</div><div class="v">${bill.paymentType}</div>
          <div class="k">Place of Supply</div><div class="v">${order?.shippingAddress?.state || customer?.kyc?.state || (process.env.COMPANY_STATE || "KA")}</div>
        </div>
      </div>
      <div class="col block">
        <h3>Bill To</h3>
        <div class="kv">
          <div class="k">Customer</div><div class="v">${customer?.name || ""}</div>
          <div class="k">Address</div><div class="v">${customer?.address || ""}</div>
          <div class="k">Phone</div><div class="v">${customer?.phone || ""}</div>
          <div class="k">GSTIN</div><div class="v">${customer?.kyc?.gstin || ""}</div>
        </div>
      </div>
    </div>
    <div style="height:12px"></div>
    <table>
      <thead><tr>
        <th style="width:60px">Item No</th>
        <th>Product Name</th>
        <th style="width:110px">HSN/SAC</th>
        <th style="width:80px" class="num">Qty</th>
        <th style="width:120px" class="num">Price/Unit</th>
        <th style="width:130px" class="num">Taxable Amt</th>
        <th style="width:90px" class="num">CGST %</th>
        <th style="width:90px" class="num">SGST %</th>
        <th style="width:130px" class="num">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="height:12px"></div>
    <div class="row">
      <div class="col block">
        <h3>Tax Summary</h3>
        <div class="kv">
          <div class="k">CGST Amount</div><div class="v">${fmt(cgstTotal)}</div>
          <div class="k">SGST Amount</div><div class="v">${fmt(sgstTotal)}</div>
          <div class="k">Tax Percent</div><div class="v">${((bill.gstBreakdown?.[0]?.rate || 0)*2) || ''}%</div>
        </div>
      </div>
      <div class="col">
        <div class="totals">
          <div class="row"><div class="label">Subtotal</div><div class="num">${fmt(bill.subtotal)}</div></div>
          <div class="row"><div class="label">Total Tax</div><div class="num">${fmt(bill.gstTotal)}</div></div>
          <div class="grand"><div class="label">Grand Total</div><div class="value">${fmt(bill.payable)}</div></div>
          <div class="amount-words">Amount in words: ${amountWords}</div>
        </div>
      </div>
    </div>
    <div style="height:12px"></div>
    <div class="block" style="border-color:#fef3c7;background:#fffbeb">
      <h3>Payment Details</h3>
      <div class="bank">
        <div>
          <div class="kv">
            <div class="k">Account Name</div><div class="v">${bank.accName}</div>
            <div class="k">Account No</div><div class="v">${bank.accNo}</div>
            <div class="k">IFSC</div><div class="v">${bank.ifsc}</div>
            <div class="k">Bank</div><div class="v">${bank.bankName}</div>
          </div>
        </div>
        <div class="right">
          <div class="stamp">UPI QR</div>
          <div class="muted" style="margin-top:6px;font-size:12px">Scan to Pay</div>
        </div>
      </div>
    </div>
    <div style="height:12px"></div>
    <div class="row">
      <div class="col block">
        <h3>Authorized Signature</h3>
        <div class="sig"></div>
        <div class="sig-lbl">For ${companyName}</div>
      </div>
      <div class="col block">
        <h3>Terms & Conditions</h3>
        <div class="terms">Goods once sold will not be taken back. Warranty as per manufacturer policy. Interest @18% p.a. will be charged on overdue invoices. All disputes subject to Bengaluru jurisdiction.</div>
      </div>
    </div>
    <div class="muted" style="text-align:center;font-size:12px;margin-top:8px">Thank you for your business with ${companyName}.</div>
  </div>
</body></html>`;
  return html;
}
