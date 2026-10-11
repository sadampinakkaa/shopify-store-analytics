import { getPeriodDates } from "./analytics.server";

// ─── CUSTOMER & GEOGRAPHY ANALYTICS SERVICE ──────────────────────────────────
// Evaluates customer retention, repeat purchase behavior, and regional sales distribution.

export async function fetchCustomerAndGeoData(admin, periodDays = 30) {
  const sinceDate = getPeriodDates(`-${periodDays}d`).currentStartDate;

  let orders = [];
  try {
    const res = await admin.graphql(
      `#graphql
      query ordersWithGeo($query: String!) {
        orders(first: 250, query: $query) {
          edges {
            node {
              id
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              shippingAddress {
                country
                countryCodeV2
                province
                city
              }
              customer {
                id
                numberOfOrders
              }
            }
          }
        }
      }`,
      {
        variables: {
          query: `status:any created_at:>=${sinceDate}`,
        },
      }
    );
    const json = await res.json();
    orders = json.data?.orders?.edges?.map((e) => e.node) ?? [];
  } catch (err) {
    console.warn("Could not query orders with geo:", err.message);
    try {
      // Basic fallback without shippingAddress if restricted
      const basicRes = await admin.graphql(
        `#graphql
        query ordersGeoBasic($query: String!) {
          orders(first: 250, query: $query) {
            edges {
              node {
                id
                createdAt
                totalPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
        }`,
        { variables: { query: `status:any created_at:>=${sinceDate}` } }
      );
      const basicJson = await basicRes.json();
      orders = basicJson.data?.orders?.edges?.map((e) => e.node) ?? [];
    } catch {
      orders = [];
    }
  }

  // ── 1. CUSTOMER METRICS CALCULATION ───────────────────────────────────────
  const customerMap = {};
  let totalRevenue = 0;

  for (const o of orders) {
    const total = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    totalRevenue += total;

    const cid = o.customer?.id || `guest-${o.id}`;
    if (!customerMap[cid]) {
      customerMap[cid] = {
        orderCount: 0,
        totalSpent: 0,
        knownRepeat: (o.customer?.numberOfOrders || 1) > 1,
      };
    }
    customerMap[cid].orderCount += 1;
    customerMap[cid].totalSpent += total;
  }

  const customerList = Object.values(customerMap);
  const totalCustomers = customerList.length;

  let newCustomers = 0;
  let returningCustomers = 0;

  for (const c of customerList) {
    if (c.orderCount > 1 || c.knownRepeat) {
      returningCustomers++;
    } else {
      newCustomers++;
    }
  }

  const repeatPurchaseRate =
    totalCustomers > 0 ? ((returningCustomers / totalCustomers) * 100).toFixed(1) : "0.0";
  const avgCustomerValue =
    totalCustomers > 0 ? (totalRevenue / totalCustomers).toFixed(2) : "0.00";
  const purchaseFrequency =
    totalCustomers > 0 ? (orders.length / totalCustomers).toFixed(2) : "1.00";

  const customerMetrics = {
    totalCustomers,
    newCustomers,
    returningCustomers,
    repeatPurchaseRate: parseFloat(repeatPurchaseRate),
    avgCustomerValue: parseFloat(avgCustomerValue),
    purchaseFrequency: parseFloat(purchaseFrequency),
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
  };

  // ── 2. GEOGRAPHIC DISTRIBUTION CALCULATION ─────────────────────────────────
  const countryMap = {};
  const provinceMap = {};
  const cityMap = {};

  for (const o of orders) {
    const total = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    const addr = o.shippingAddress;

    const country = addr?.country || "Domestic / Local";
    const countryCode = addr?.countryCodeV2 || "US";
    const province = addr?.province || "Unspecified Region";
    const city = addr?.city || "Unspecified City";

    // Country
    if (!countryMap[country]) {
      countryMap[country] = { name: country, code: countryCode, orders: 0, revenue: 0 };
    }
    countryMap[country].orders += 1;
    countryMap[country].revenue += total;

    // Province / Region
    const provKey = `${country} - ${province}`;
    if (!provinceMap[provKey]) {
      provinceMap[provKey] = { name: province, country, orders: 0, revenue: 0 };
    }
    provinceMap[provKey].orders += 1;
    provinceMap[provKey].revenue += total;

    // City
    const cityKey = `${city}, ${province}`;
    if (!cityMap[cityKey]) {
      cityMap[cityKey] = { name: city, province, country, orders: 0, revenue: 0 };
    }
    cityMap[cityKey].orders += 1;
    cityMap[cityKey].revenue += total;
  }

  const countries = Object.values(countryMap)
    .sort((a, b) => b.revenue - a.revenue)
    .map((c) => ({
      ...c,
      revenue: Math.round(c.revenue * 100) / 100,
      share: totalRevenue > 0 ? ((c.revenue / totalRevenue) * 100).toFixed(1) : "0.0",
    }));

  const provinces = Object.values(provinceMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15)
    .map((p) => ({
      ...p,
      revenue: Math.round(p.revenue * 100) / 100,
      share: totalRevenue > 0 ? ((p.revenue / totalRevenue) * 100).toFixed(1) : "0.0",
    }));

  const cities = Object.values(cityMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15)
    .map((ct) => ({
      ...ct,
      revenue: Math.round(ct.revenue * 100) / 100,
      share: totalRevenue > 0 ? ((ct.revenue / totalRevenue) * 100).toFixed(1) : "0.0",
    }));

  return {
    customerMetrics,
    geoMetrics: {
      countries,
      provinces,
      cities,
      totalOrders: orders.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
    },
  };
}
