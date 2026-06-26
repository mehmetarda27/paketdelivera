require("dotenv").config({ path: "./.env" });

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const url = process.env.WEBHOOK_TEST_URL || `http://localhost:${PORT}/api/webhooks/orders`;

const payload = {
  pid: "a7j7-2619-ni3r",
  restaurantId: "6377deac15d5d59aee02bf51",
  restaurantName: "Cizbiz Sucuk",
  confirmationId: "WVNfVFItNThhNDM0NzMtNzRiOS00Nzg1LWFlZmUtNTdlYTE3NmJiYzc2",
  provider: {
    slug: "ys",
    kaynak: "Yemek Sepeti",
    id: "60cdef4f451ac719569864f4",
    alici: "yswh",
  },
  client: {
    id: "trnrqp3y",
    name: "Orhan Genckiren",
    location: {
      lat: "41.1185938",
      lon: "29.0022812",
      text: "41.1185938 29.0022812",
    },
    clientPhoneNumber: "5421803474",
    contactPhoneNumber: "5421803474",
    deliveryAddress: {
      address: "190. Sk.",
      aptNo: "8-C",
      floor: "Giris",
      doorNo: "0",
      city: "Istanbul",
      district: "Ayazaga Sariyer",
      street: "190. Sk.",
      description: "0",
    },
  },
  status: 900,
  totalPrice: 400,
  totalDiscountedPrice: 340,
  totalDiscount: 60,
  clientNote: "CATAL BICAK GONDERMEYIN Nakit",
  deliveryType: 2,
  paymentMethod: "1",
  paymentMethodText: {
    tr: "Nakit",
    en: "Nakit",
  },
  posPaymentMethod: "Nakit",
  pos_ticket: 228664,
  products: [
    {
      id: "3294488",
      count: "1",
      product: "fb470646-2ee9-4109-bd05-8bbc96cc96ff",
      note: "tursu olmasin icinde lutfen",
      name: {
        tr: "Tam Ekmek Arasi Karisik Izgara",
        en: "Tam Ekmek Arasi Karisik Izgara",
      },
      price: "400",
      optionPrice: 0,
      priceWithOption: 400,
      totalPrice: 400,
    },
  ],
  restaurant: {
    id: "6377deac15d5d59aee02bf51",
    name: "Cizbiz Sucuk",
  },
  shortCode: "5586",
};

async function main() {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(JSON.stringify({ status: response.status, body }, null, 2));
  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
