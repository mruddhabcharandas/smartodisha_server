import fetch from "node-fetch";

/* =========================
CONFIG
========================= */

const sanitize = (v) =>
String(v || "")
.trim()
.replace(/^['"`]+|['"`]+$/g, "")
.replace(//+$/, "");

const BASE_URL =
sanitize(
process.env.DELHIVERY_BASE_URL ||
"https://staging-express.delhivery.com"
);

const API_TOKEN =
process.env.DELHIVERY_API_TOKEN ||
process.env.DELHIVERY_TOKEN;

if (!API_TOKEN) {
throw new Error(
"DELHIVERY_API_TOKEN missing"
);
}

const authHeaders = () => ({
Authorization: `Token ${API_TOKEN}`
});

async function parseResponse(res) {
const text = await res.text();

console.log(
"Delhivery:",
res.status,
text
);

if (!res.ok) {
throw new Error(
`Delhivery ${res.status}: ${text}`
);
}

try {
return JSON.parse(text);
} catch {
return text;
}
}

/* =========================
SERVICEABILITY
========================= */

export const checkServiceability =
async (pincode) => {

const url =
`${BASE_URL}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(
pincode
)}`;

const res =
await fetch(url,{
headers: authHeaders()
});

const json =
await parseResponse(res);

const list =
json?.delivery_codes || [];

if (
!Array.isArray(list) ||
list.length === 0
) {
return {
pincode,
delivery_available:false,
cod_available:false
};
}

const postal =
list
.map(
x=>x?.postal_code
)
.find(
x=>
x &&
x.remark !==
"Embargo"
);

return {
pincode,
delivery_available:
!!postal,

```
cod_available:
  postal?.cod === true
```

};
};

/* =========================
SHIPPING COST
(NO DUMMY RATE)
========================= */

export const calculateShippingCost =
async () => {

throw new Error(
"Use Delhivery live pricing API. Static shipping disabled."
);

};

/* =========================
CREATE SHIPMENT
========================= */

export const createShipment =
async (shipmentData) => {

const url =
`${BASE_URL}/api/cmu/create.json`;

const payload =
shipmentData?.data?.shipments
? shipmentData.data
: shipmentData;

console.log(
"Shipment Payload:",
JSON.stringify(
payload,
null,
2
)
);

const body =
new URLSearchParams({
format:"json",
data:
JSON.stringify(
payload
)
});

const res =
await fetch(
url,
{
method:"POST",

headers:{
...authHeaders(),

"Content-Type":
"application/x-www-form-urlencoded"
},

body
}
);

return await parseResponse(
res
);

};

/* =========================
TRACK
========================= */

export const trackShipment =
async (
waybill
)=>{

const url =
`${BASE_URL}/api/v1/packages/json/?waybill=${waybill}`;

const res =
await fetch(
url,
{
headers:
authHeaders()
}
);

return await parseResponse(
res
);

};

/* =========================
LABEL
========================= */

export const generateLabel =
async (
waybills
)=>{

const url =
`${BASE_URL}/api/p/packing-slip`;

const res =
await fetch(
url,
{
method:"POST",

headers:{
...authHeaders(),
"Content-Type":
"application/json"
},

body:
JSON.stringify({
waybills:
Array.isArray(
waybills
)
? waybills
: [waybills]
})
}
);

return await parseResponse(
res
);

};
