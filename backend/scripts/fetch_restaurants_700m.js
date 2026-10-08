require("dotenv").config();

const axios = require("axios");
const { Client } = require("pg");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !DATABASE_URL) {
  console.error("請確認 .env 有 GOOGLE_MAPS_API_KEY 和 DATABASE_URL");
  process.exit(1);
}

// 沿用原本中原大學的座標，範圍以直線距離計算。
const CENTER = {
  lat: 24.9568,
  lng: 121.2385
};

const RADIUS = 500;

// 每個關鍵字最多搜尋三頁。
// 想減少 API 呼叫，可刪減關鍵字。
const KEYWORDS = [
  "餐廳",
  "飲料店",
  "手搖飲",
  "咖啡",
  "早餐",
  "早午餐",
  "便當",
  "牛肉麵",
  "小吃",
  "火鍋",
  "日式料理",
  "韓式料理",
  "義大利麵",
  "素食",
  "甜點",
  "宵夜",
  "咖啡哪有上班苦"
];

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

// 計算餐廳與中原大學中心的直線距離。
function getDistance(lat, lng) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return Infinity;
  }

  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat - CENTER.lat);
  const dLng = rad(lng - CENTER.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(CENTER.lat)) *
      Math.cos(rad(lat)) *
      Math.sin(dLng / 2) ** 2;

  return 6371000 * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(Math.max(0, 1 - a))
  );
}

async function fetchPage(keyword, pageToken) {
  const params = pageToken
    ? {
        key: API_KEY,
        pagetoken: pageToken,
        language: "zh-TW"
      }
    : {
        key: API_KEY,
        location: `${CENTER.lat},${CENTER.lng}`,
        radius: RADIUS,
        keyword,
        language: "zh-TW"
      };

  // 下一頁 token 可能需要等待才能使用。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (pageToken) {
      await sleep(2500);
    }

    let data;

    try {
      const response = await axios.get(
        "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
        { params, timeout: 15000 }
      );

      data = response.data;
    } catch (error) {
      // 不輸出完整請求，避免日誌包含 API 金鑰。
      throw new Error(
        `搜尋「${keyword}」連線失敗：${error.code || "NETWORK_ERROR"}`
      );
    }

    if (pageToken && data.status === "INVALID_REQUEST") {
      continue;
    }

    if (!["OK", "ZERO_RESULTS"].includes(data.status)) {
      throw new Error(
        `Google API：${data.status} ${data.error_message || ""}`
      );
    }

    return data;
  }

  throw new Error(`搜尋「${keyword}」的下一頁 token 仍未生效`);
}

async function insertRestaurant(db, place) {
  // 每家新店與照片一起寫入；失敗就回復這家新增。
  await db.query("BEGIN");

  try {
    const location = place.geometry.location;

    const result = await db.query(
      `
      INSERT INTO restaurants (
        google_place_id,
        name,
        address,
        lat,
        lng,
        rating,
        user_ratings_total,
        price_level,
        opening_now,
        business_status,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (google_place_id) DO NOTHING
      RETURNING id
      `,
      [
        place.place_id,
        place.name,
        place.vicinity || place.formatted_address || null,
        location.lat,
        location.lng,
        place.rating ?? null,
        place.user_ratings_total ?? null,
        place.price_level ?? null,
        place.opening_hours?.open_now ?? null,
        place.business_status ?? null
      ]
    );

    if (result.rowCount === 0) {
      await db.query("COMMIT");
      return false;
    }

    const restaurantId = result.rows[0].id;
    const photos = Array.isArray(place.photos)
      ? place.photos.slice(0, 3)
      : [];

    for (const photo of photos) {
      if (!photo.photo_reference) continue;

      await db.query(
        `
        INSERT INTO restaurant_photos (
          restaurant_id,
          photo_reference,
          width,
          height
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING
        `,
        [
          restaurantId,
          photo.photo_reference,
          photo.width ?? null,
          photo.height ?? null
        ]
      );
    }

    await db.query("COMMIT");
    return true;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const db = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("render.com")
      ? { rejectUnauthorized: false }
      : false
  });

  try {
    await db.connect();

    // 先檢查欄位，避免搜尋完才發現資料表不符。
    await db.query(`
      SELECT google_place_id, name, address, lat, lng,
             rating, user_ratings_total, price_level,
             opening_now, business_status, updated_at
      FROM restaurants LIMIT 0
    `);

    await db.query(`
      SELECT restaurant_id, photo_reference, width, height
      FROM restaurant_photos LIMIT 0
    `);

    // EXPLAIN 不會新增資料，只確認 Place ID 衝突處理可用。
    await db.query(`
      EXPLAIN INSERT INTO restaurants (google_place_id)
      VALUES ('validation-only')
      ON CONFLICT (google_place_id) DO NOTHING
    `);

    const existingResult = await db.query(`
      SELECT google_place_id
      FROM restaurants
      WHERE google_place_id IS NOT NULL
    `);

    const existing = new Set(
      existingResult.rows.map(row => row.google_place_id)
    );

    const seen = new Set();

    let added = 0;
    let skipped = 0;
    let outside = 0;
    let invalid = 0;
    let failed = 0;

    console.log("✅ PostgreSQL 已連線");
    console.log("📍 只新增中原大學中心直線 700 公尺內的店");
    console.log("🔒 原有資料不刪除、不修改");

    for (const keyword of KEYWORDS) {
      console.log(`\n🔎 搜尋：${keyword}`);

      let token = null;

      for (let page = 1; page <= 3; page++) {
        const data = await fetchPage(keyword, token);
        const places = data.results || [];

        console.log(`第 ${page} 頁：${places.length} 筆`);

        for (const place of places) {
          if (!place.place_id) {
            invalid++;
            continue;
          }

          if (seen.has(place.place_id)) continue;
          seen.add(place.place_id);

          // 已有餐廳完全不動。
          if (existing.has(place.place_id)) {
            skipped++;
            continue;
          }

          const location = place.geometry?.location;

          if (
            !place.name ||
            !location ||
            !Number.isFinite(location.lat) ||
            !Number.isFinite(location.lng)
          ) {
            invalid++;
            continue;
          }

          const distance = getDistance(location.lat, location.lng);

          // 不能只依賴 API radius，寫入前再嚴格過濾。
          if (distance > RADIUS) {
            outside++;
            continue;
          }

          try {
            const inserted = await insertRestaurant(db, place);

            if (inserted) {
              added++;
              existing.add(place.place_id);
              console.log(
                `🆕 ${place.name}（約 ${Math.round(distance)} 公尺）`
              );
            } else {
              skipped++;
            }
          } catch (error) {
            failed++;
            console.error(
              `❌ ${place.name} 新增失敗：${error.message}`
            );
          }
        }

        token = data.next_page_token;
        if (!token) break;
      }

      await sleep(300);
    }

    console.log("\n===== 執行結果 =====");
    console.log(`新增：${added} 家`);
    console.log(`已存在，未修改：${skipped} 家`);
    console.log(`超過 700 公尺：${outside} 家`);
    console.log(`資料不完整：${invalid} 家`);
    console.log(`新增失敗：${failed} 家`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(`❌ 執行中止：${error.message}`);
  process.exitCode = 1;
});