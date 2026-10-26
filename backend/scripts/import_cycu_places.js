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

// ======================================================
// 搜尋位置
// ======================================================

const LOCATIONS = [
  { lat: 24.9581639, lng: 121.2417917 }, // 中原大學
  { lat: 24.9568, lng: 121.2385 },       // 中原夜市
  { lat: 24.9615, lng: 121.2460 },       // 中山東路
  { lat: 24.9545, lng: 121.2445 },       // 實踐路
  { lat: 24.9605, lng: 121.2365 }        // 環中東路
];

// 搜尋半徑 1500 公尺
const RADIUS_METERS = 1500;

// ======================================================
// 搜尋類型
// ======================================================

// 如果你只想抓飲料店，
// 可以把「餐廳」和「咖啡」刪掉。
const SEARCH_KEYWORDS = [
  "餐廳",
  "飲料店",
  "手搖飲",
  "咖啡"
];

const NEARBY_URL =
  "https://maps.googleapis.com/maps/api/place/nearbysearch/json";

// ======================================================
// Nearby Search 資料轉換
// ======================================================

function mapNearbyToRestaurant(row, keyword) {
  return {
    google_place_id: row.place_id || null,

    name: row.name || null,

    address:
      row.vicinity ||
      row.formatted_address ||
      null,

    lat:
      row.geometry?.location?.lat ??
      null,

    lng:
      row.geometry?.location?.lng ??
      null,

    rating:
      row.rating ??
      null,

    user_ratings_total:
      row.user_ratings_total ??
      null,

    price_level:
      row.price_level ??
      null,

    opening_now:
      row.opening_hours?.open_now ??
      null,

    business_status:
      row.business_status ??
      null,

    // 搜尋來源
    search_keyword: keyword,

    // Nearby 回傳的照片
    photos:
      Array.isArray(row.photos)
        ? row.photos
        : []
  };
}

// ======================================================
// sleep
// ======================================================

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ======================================================
// Nearby Search
// ======================================================

async function fetchNearbyPage({
  location,
  keyword,
  pageToken = null
}) {
  let params;

  // ----------------------------------------
  // 下一頁
  // ----------------------------------------

  if (pageToken) {
    params = {
      key: API_KEY,
      pagetoken: pageToken,
      language: "zh-TW"
    };
  }

  // ----------------------------------------
  // 第一頁
  // ----------------------------------------

  else {
    params = {
      key: API_KEY,

      location:
        `${location.lat},${location.lng}`,

      radius:
        RADIUS_METERS,

      // 不使用 type: restaurant
      // 避免飲料店被過濾掉
      keyword:
        keyword,

      language:
        "zh-TW"
    };
  }

  const resp = await axios.get(
    NEARBY_URL,
    {
      params,
      timeout: 15000
    }
  );

  const data = resp.data;

  // ----------------------------------------
  // Google 的 next_page_token
  // 有時取得後不能馬上用
  // ----------------------------------------

  if (
    data.status === "INVALID_REQUEST" &&
    pageToken
  ) {
    return {
      retry: true
    };
  }

  // ----------------------------------------
  // API Error
  // ----------------------------------------

  if (
    data.status !== "OK" &&
    data.status !== "ZERO_RESULTS"
  ) {
    throw new Error(
      `Nearby API error: ${data.status} ${
        data.error_message || ""
      }`
    );
  }

  return {
    results:
      data.results || [],

    next_page_token:
      data.next_page_token || null
  };
}

// ======================================================
// 新增餐廳
//
// 重要：
// 已經存在的 google_place_id 完全不修改
// ======================================================

async function insertNewRestaurants(
  client,
  restaurants
) {
  const sql = `
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
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      NOW()
    )

    ON CONFLICT (google_place_id)
    DO NOTHING

    RETURNING id
  `;

  let inserted = 0;
  let skipped = 0;
  let invalid = 0;

  for (const r of restaurants) {
    // ----------------------------------------
    // 必要資料不完整
    // ----------------------------------------

    if (
      !r.google_place_id ||
      !r.name ||
      r.lat == null ||
      r.lng == null
    ) {
      invalid++;

      console.log(
        `[INVALID] 資料不完整，跳過：${r.name || "Unknown"}`
      );

      continue;
    }

    try {
      // ----------------------------------------
      // INSERT
      // ----------------------------------------

      const result =
        await client.query(
          sql,
          [
            r.google_place_id,
            r.name,
            r.address,
            r.lat,
            r.lng,
            r.rating,
            r.user_ratings_total,
            r.price_level,
            r.opening_now,
            r.business_status
          ]
        );

      // ==================================================
      // 已經存在
      //
      // DO NOTHING 後 rowCount = 0
      // 原本的餐廳完全不動
      // ==================================================

      if (result.rowCount === 0) {
        skipped++;

        console.log(
          `[SKIP] 已存在，不修改：${r.name}`
        );

        continue;
      }

      // ==================================================
      // 新店家
      // ==================================================

      const restaurantId =
        result.rows[0].id;

      inserted++;

      console.log(
        `[NEW] 新增：${r.name}（${r.search_keyword}）`
      );

      // ==================================================
      // 只有新店才新增 Nearby 照片
      // ==================================================

      if (
        Array.isArray(r.photos) &&
        r.photos.length > 0
      ) {
        for (
          const photo
          of r.photos.slice(0, 3)
        ) {
          if (
            !photo.photo_reference
          ) {
            continue;
          }

          try {
            await client.query(
              `
              INSERT INTO restaurant_photos (
                restaurant_id,
                photo_reference,
                width,
                height
              )
              VALUES (
                $1,
                $2,
                $3,
                $4
              )
              ON CONFLICT DO NOTHING
              `,
              [
                restaurantId,
                photo.photo_reference,
                photo.width || null,
                photo.height || null
              ]
            );
          } catch (photoError) {
            console.error(
              `[PHOTO ERROR] ${r.name}: ${photoError.message}`
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `[DB ERROR] ${r.name}: ${error.message}`
      );
    }
  }

  return {
    inserted,
    skipped,
    invalid
  };
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  const pg = new Client({
    connectionString:
      DATABASE_URL,

    ssl: {
      rejectUnauthorized:
        false
    }
  });

  await pg.connect();

  console.log("");
  console.log(
    "✅ Connected to PostgreSQL"
  );

  try {
    let all = [];

    // ==================================================
    // 每個搜尋位置
    // ==================================================

    for (
      const location
      of LOCATIONS
    ) {
      console.log("");
      console.log(
        "=============================================="
      );

      console.log(
        `📍 搜尋位置：${location.lat}, ${location.lng}`
      );

      console.log(
        "=============================================="
      );

      // =================================================
      // 每個關鍵字
      // =================================================

      for (
        const keyword
        of SEARCH_KEYWORDS
      ) {
        console.log("");
        console.log(
          `🔎 搜尋關鍵字：${keyword}`
        );

        let pageToken = null;
        let page = 0;

        // ===============================================
        // 每個 keyword 最多抓三頁
        // ===============================================

        while (true) {
          page++;

          // 下一頁 token 要稍微等待
          if (pageToken) {
            await sleep(2000);
          }

          let res =
            await fetchNearbyPage({
              location,
              keyword,
              pageToken
            });

          // ---------------------------------------------
          // token 尚未生效
          // ---------------------------------------------

          if (res.retry) {
            console.log(
              "⏳ next_page_token 尚未生效，等待後重試..."
            );

            await sleep(2500);

            res =
              await fetchNearbyPage({
                location,
                keyword,
                pageToken
              });
          }

          // ---------------------------------------------
          // 如果第二次還是 retry
          // ---------------------------------------------

          if (res.retry) {
            console.log(
              "⚠️ next_page_token 仍未生效，本次停止抓下一頁"
            );

            break;
          }

          const mapped =
            (
              res.results || []
            ).map(
              (row) =>
                mapNearbyToRestaurant(
                  row,
                  keyword
                )
            );

          all =
            all.concat(mapped);

          console.log(
            `[Nearby] ${keyword} page ${page}: ${mapped.length} results`
          );

          // 顯示抓到哪些店
          for (
            const restaurant
            of mapped
          ) {
            console.log(
              `   - ${restaurant.name}`
            );
          }

          pageToken =
            res.next_page_token;

          // Nearby Legacy
          // 最多 3 頁
          if (
            !pageToken ||
            page >= 3
          ) {
            break;
          }
        }

        // 不要太密集呼叫 API
        await sleep(300);
      }
    }

    // ==================================================
    // google_place_id 去除重複
    // ==================================================

    const uniqueMap =
      new Map();

    for (const restaurant of all) {
      if (
        !restaurant.google_place_id
      ) {
        continue;
      }

      // 已經抓過同一間
      // 保留第一次抓到的資料
      if (
        !uniqueMap.has(
          restaurant.google_place_id
        )
      ) {
        uniqueMap.set(
          restaurant.google_place_id,
          restaurant
        );
      }
    }

    const unique =
      Array.from(
        uniqueMap.values()
      );

    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      `📥 Google 原始抓取數量：${all.length}`
    );

    console.log(
      `🔄 google_place_id 去重後：${unique.length}`
    );

    console.log(
      "=============================================="
    );

    // ==================================================
    // 寫進資料庫
    // ==================================================

    const result =
      await insertNewRestaurants(
        pg,
        unique
      );

    // ==================================================
    // 最後結果
    // ==================================================

    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      "✅ 執行完成"
    );

    console.log(
      `🆕 新增新店：${result.inserted} 家`
    );

    console.log(
      `⏭️ 原本已有、不修改：${result.skipped} 家`
    );

    console.log(
      `⚠️ 資料不完整跳過：${result.invalid} 家`
    );

    console.log(
      `📥 Google 原始結果：${all.length} 筆`
    );

    console.log(
      `🔄 Google 去重後：${unique.length} 家`
    );

    console.log(
      "=============================================="
    );
  } finally {
    await pg.end();

    console.log("");
    console.log(
      "✅ PostgreSQL disconnected"
    );
  }
}

// ======================================================
// RUN
// ======================================================

main().catch((error) => {
  console.error("");
  console.error(
    "❌ 執行失敗："
  );

  console.error(error);

  process.exit(1);
});