require("dotenv").config();

const axios = require("axios");
const { Client } = require("pg");

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !DATABASE_URL) {
  console.error("請確認 .env 有 GOOGLE_MAPS_API_KEY 和 DATABASE_URL");
  process.exit(1);
}

const LOCATIONS = [
  { name: "中原大學", lat: 24.9581639, lng: 121.2417917 },
  { name: "中原夜市", lat: 24.9568, lng: 121.2385 },
  { name: "中山東路", lat: 24.9615, lng: 121.2460 },
  { name: "實踐路", lat: 24.9545, lng: 121.2445 },
  { name: "環中東路", lat: 24.9605, lng: 121.2365 }
];

const RADIUS = 500;

// 每個搜尋點、每個關鍵字最多搜尋三頁。
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

// 計算店家與指定搜尋點的直線距離，單位為公尺。
function getDistance(lat, lng, center) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return Infinity;
  }

  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat - center.lat);
  const dLng = rad(lng - center.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(center.lat)) *
      Math.cos(rad(lat)) *
      Math.sin(dLng / 2) ** 2;

  const clamped = Math.min(1, Math.max(0, a));

  return 6371000 * 2 * Math.atan2(
    Math.sqrt(clamped),
    Math.sqrt(1 - clamped)
  );
}

// 找出距離店家最近的搜尋點。
// 只要距離任一點不超過 500 公尺，就符合新增範圍。
function getNearestLocation(lat, lng) {
  let nearest = null;
  let distance = Infinity;

  for (const location of LOCATIONS) {
    const currentDistance = getDistance(lat, lng, location);

    if (currentDistance < distance) {
      nearest = location;
      distance = currentDistance;
    }
  }

  return { location: nearest, distance };
}

async function fetchPage(location, keyword, pageToken) {
  const params = pageToken
    ? {
        key: API_KEY,
        pagetoken: pageToken,
        language: "zh-TW"
      }
    : {
        key: API_KEY,
        location: `${location.lat},${location.lng}`,
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
        `搜尋連線失敗：${error.code || "NETWORK_ERROR"}`
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

  throw new Error("下一頁 token 仍未生效");
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

    // 已存在時不修改，也不補寫照片。
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

    // 搜尋前先確認資料表欄位。
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

    // EXPLAIN 不會新增資料，只確認衝突處理可用。
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

    // 五個搜尋點共用，避免同一家重複處理。
    const seen = new Set();

    let added = 0;
    let skipped = 0;
    let repeated = 0;
    let outside = 0;
    let invalid = 0;
    let failed = 0;
    let searchFailed = 0;

    console.log("✅ PostgreSQL 已連線");
    console.log(`📍 搜尋 ${LOCATIONS.length} 個位置，各 ${RADIUS} 公尺`);
    console.log(`📚 資料庫已有 ${existing.size} 個 Place ID`);
    console.log("🔒 原有資料不刪除、不修改");

    for (const location of LOCATIONS) {
      console.log(`\n========== ${location.name} ==========`);

      for (const keyword of KEYWORDS) {
        console.log(`\n🔎 ${location.name}｜${keyword}`);

        let token = null;

        for (let page = 1; page <= 3; page++) {
          let data;

          try {
            data = await fetchPage(location, keyword, token);
          } catch (error) {
            searchFailed++;

            console.error(
              `❌ ${location.name}｜${keyword}｜第 ${page} 頁：${error.message}`
            );

            // 本次搜尋失敗，繼續下一個關鍵字。
            break;
          }

          const places = Array.isArray(data.results)
            ? data.results
            : [];

          console.log(`第 ${page} 頁：${places.length} 筆`);

          for (const place of places) {
            if (!place.place_id) {
              invalid++;
              continue;
            }

            if (seen.has(place.place_id)) {
              repeated++;
              continue;
            }

            seen.add(place.place_id);

            // 已有餐廳完全不動。
            if (existing.has(place.place_id)) {
              skipped++;
              continue;
            }

            const coordinates = place.geometry?.location;

            if (
              !place.name ||
              !coordinates ||
              !Number.isFinite(coordinates.lat) ||
              !Number.isFinite(coordinates.lng)
            ) {
              invalid++;
              continue;
            }

            const nearest = getNearestLocation(
              coordinates.lat,
              coordinates.lng
            );

            // API 搜尋結果仍須以實際距離過濾。
            if (nearest.distance > RADIUS) {
              outside++;
              continue;
            }

            try {
              const inserted = await insertRestaurant(db, place);

              if (inserted) {
                added++;
                existing.add(place.place_id);

                console.log(
                  `🆕 ${place.name}（距${nearest.location.name}約 ` +
                  `${Math.round(nearest.distance)} 公尺）`
                );
              } else {
                skipped++;
                existing.add(place.place_id);
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
    }

    console.log("\n===== 執行結果 =====");
    console.log(`新增：${added} 家`);
    console.log(`已存在，未修改：${skipped} 家`);
    console.log(`搜尋結果重複，略過：${repeated} 筆`);
    console.log(`不在任一搜尋點 ${RADIUS} 公尺內：${outside} 家`);
    console.log(`資料不完整或座標無效：${invalid} 筆`);
    console.log(`新增失敗：${failed} 家`);
    console.log(`搜尋失敗：${searchFailed} 次`);

    if (failed > 0 || searchFailed > 0) {
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