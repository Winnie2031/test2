/**
 * scripts/import_cycu_places.js
 *
 * 目的：
 *  - 用 Google Places Nearby Search 抓「中原大學」500 公尺附近餐廳
 *  - 將基本欄位 upsert 到 PostgreSQL：restaurants
 *
 * 需要 .env：
 *  - GOOGLE_MAPS_API_KEY
 *  - DATABASE_URL (postgresql://.../F00D)
 *
 * 執行：
 *  node scripts/import_cycu_places.js
 */

require("dotenv").config();
const axios = require("axios");
const { Client } = require("pg");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("Missing GOOGLE_MAPS_API_KEY in .env");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}

// 中原大學座標（小數）
const CYCU = { lat: 24.9581639, lng: 121.2417917 };
const RADIUS_METERS = 500;

// Nearby Search：每頁最多 20，最多 3 頁 ≈ 60
const NEARBY_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";

// 你想抓的「基本欄位」：Nearby Search 回來就有的
function mapNearbyToRestaurant(row) {
  const placeId = row.place_id;
  const name = row.name || null;

  // 地址：Nearby Search 用 vicinity（比較常見）
  const address = row.vicinity || row.formatted_address || null;

  const lat = row.geometry?.location?.lat ?? null;
  const lng = row.geometry?.location?.lng ?? null;

  const rating = row.rating ?? null;
  const userRatingsTotal = row.user_ratings_total ?? null;
  const priceLevel = row.price_level ?? null;

  const openingNow = row.opening_hours?.open_now ?? null;
  const businessStatus = row.business_status ?? null;

  return {
    google_place_id: placeId,
    name,
    address,
    lat,
    lng,
    rating,
    user_ratings_total: userRatingsTotal,
    price_level: priceLevel,
    opening_now: openingNow,
    business_status: businessStatus,
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Nearby Search：抓一頁（含 next_page_token）
async function fetchNearbyPage({ pageToken = null }) {
  const params = pageToken
    ? { key: API_KEY, pagetoken: pageToken }
    : {
        key: API_KEY,
        location: `${CYCU.lat},${CYCU.lng}`,
        radius: RADIUS_METERS,
        type: "restaurant",
        language: "zh-TW",
      };

  const resp = await axios.get(NEARBY_URL, { params, timeout: 15000 });
  const data = resp.data;

  // next_page_token 剛出來時，Google 可能回 INVALID_REQUEST，需要等一下再打
  if (data.status === "INVALID_REQUEST" && pageToken) {
    return { retry: true };
  }

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Nearby API error: ${data.status} ${data.error_message || ""}`);
  }

  return {
    results: data.results || [],
    next_page_token: data.next_page_token || null,
  };
}

async function upsertRestaurants(client, restaurants) {
  // 單筆 upsert（最穩、好除錯）
  const sql = `
    INSERT INTO restaurants (
      google_place_id, name, address, lat, lng,
      rating, user_ratings_total, price_level,
      opening_now, business_status,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,
      $9,$10,
      NOW()
    )
    ON CONFLICT (google_place_id) DO UPDATE SET
      name = EXCLUDED.name,
      address = EXCLUDED.address,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      rating = EXCLUDED.rating,
      user_ratings_total = EXCLUDED.user_ratings_total,
      price_level = EXCLUDED.price_level,
      opening_now = EXCLUDED.opening_now,
      business_status = EXCLUDED.business_status,
      updated_at = NOW()
  `;

  let insertedOrUpdated = 0;

  for (const r of restaurants) {
    // 基本防呆：place_id/lat/lng 必須有
    if (!r.google_place_id || r.lat == null || r.lng == null || !r.name) continue;

    await client.query(sql, [
      r.google_place_id,
      r.name,
      r.address,
      r.lat,
      r.lng,
      r.rating,
      r.user_ratings_total,
      r.price_level,
      r.opening_now,
      r.business_status,
    ]);
    insertedOrUpdated++;
  }
  return insertedOrUpdated;
}

async function main() {
  const pg = new Client({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
  await pg.connect();

  try {
    let all = [];
    let pageToken = null;
    let page = 0;

    while (true) {
      page++;

      // Google 規則：打 next_page_token 前通常要等 1~2 秒 token 才會生效
      if (pageToken) await sleep(1500);

      // 取得一頁
      let res = await fetchNearbyPage({ pageToken });

      // 若 INVALID_REQUEST（token 還沒 ready），等一下重打
      if (res.retry) {
        await sleep(1500);
        res = await fetchNearbyPage({ pageToken });
      }

      const mapped = (res.results || []).map(mapNearbyToRestaurant);
      all = all.concat(mapped);

      console.log(`[Nearby] page ${page}: ${mapped.length} results`);

      pageToken = res.next_page_token;

      // Nearby Search 最多 3 頁（通常 60）
      if (!pageToken || page >= 3) break;
    }

    const n = await upsertRestaurants(pg, all);

    console.log(`Done. upserted ${n} restaurants (raw fetched: ${all.length})`);
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
