/**
 * scripts/enrich_place_details.js
 *
 * 目的：
 *  - 從 restaurants 取出需要補 details 的店
 *  - 用 Place Details API（Legacy Web Service）抓更多細節
 *  - 只補「原本沒有的資料」
 *  - 原本已有資料不刪除、不覆蓋
 *  - 照片只新增不存在的 photo_reference
 *
 * 執行：
 * node scripts/enrich_place_details.js
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

const DETAILS_URL =
  "https://maps.googleapis.com/maps/api/place/details/json";

// ======================================================
// Place Details 欄位
// ======================================================

const DETAILS_FIELDS = [
  "place_id",
  "formatted_address",
  "formatted_phone_number",
  "international_phone_number",
  "website",
  "url",
  "opening_hours",
  "utc_offset",
  "delivery",
  "dine_in",
  "takeout",
  "reservable",
  "wheelchair_accessible_entrance",
  "photos"
].join(",");

// 一次處理幾家
const BATCH_LIMIT = 200;

// 每筆 API 間隔
const SLEEP_MS = 200;

// ======================================================
// 這版只處理 details_fetched_at IS NULL
//
// 避免 14 天後又重新抓，然後動到原本資料
// ======================================================

const MAX_PHOTOS_PER_PLACE = 10;

// ======================================================
// sleep
// ======================================================

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ======================================================
// Google Place Details
// ======================================================

async function fetchPlaceDetails(placeId) {
  const resp = await axios.get(
    DETAILS_URL,
    {
      params: {
        key: API_KEY,
        place_id: placeId,
        fields: DETAILS_FIELDS,
        language: "zh-TW"
      },

      timeout: 15000
    }
  );

  const data = resp.data;

  if (data.status !== "OK") {
    console.error(
      "Details raw:",
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      `Details API error: ${data.status} ${
        data.error_message || ""
      }`.trim()
    );
  }

  return data.result;
}

// ======================================================
// 找需要補詳細資料的店
//
// 重要：
// 只抓 details_fetched_at IS NULL
//
// 已經補過的店不再處理
// ======================================================

async function pickTargets(pg) {
  const sql = `
    SELECT
      google_place_id,
      name
    FROM restaurants

    WHERE google_place_id IS NOT NULL

      AND details_fetched_at IS NULL

    ORDER BY updated_at DESC

    LIMIT $1
  `;

  const res =
    await pg.query(
      sql,
      [BATCH_LIMIT]
    );

  return res.rows;
}

// ======================================================
// 更新 Details
//
// 核心原則：
// DB 原本有值 → 保留
// DB 原本 NULL → 才用 Google 的值
// ======================================================

async function updateRestaurantDetails(
  pg,
  details
) {
  const placeId =
    details.place_id;

  const address =
    details.formatted_address ||
    null;

  const phone =
    details.formatted_phone_number ||
    null;

  const website =
    details.website ||
    null;

  const googleMapsUrl =
    details.url ||
    null;

  const utcOffset =
    details.utc_offset ??
    null;

  const delivery =
    details.delivery ??
    null;

  const dineIn =
    details.dine_in ??
    null;

  const takeout =
    details.takeout ??
    null;

  const reservable =
    details.reservable ??
    null;

  const wheelchair =
    details.wheelchair_accessible_entrance ??
    null;

  // ==================================================
  // 營業時間
  // ==================================================

  const openingHoursJson =
    details.opening_hours?.periods
      ? JSON.stringify(
          details.opening_hours.periods
        )
      : null;

  // ==================================================
  // 關鍵：
  //
  // COALESCE(原本資料, 新資料)
  //
  // 原本有 → 保留原本
  // 原本 NULL → 使用新資料
  // ==================================================

  const sql = `
    UPDATE restaurants

    SET

      address =
        COALESCE(
          address,
          $1
        ),

      phone =
        COALESCE(
          phone,
          $2
        ),

      website =
        COALESCE(
          website,
          $3
        ),

      google_maps_url =
        COALESCE(
          google_maps_url,
          $4
        ),

      utc_offset_minutes =
        COALESCE(
          utc_offset_minutes,
          $5
        ),

      delivery =
        COALESCE(
          delivery,
          $6
        ),

      dine_in =
        COALESCE(
          dine_in,
          $7
        ),

      takeout =
        COALESCE(
          takeout,
          $8
        ),

      reservable =
        COALESCE(
          reservable,
          $9
        ),

      wheelchair_accessible_entrance =
        COALESCE(
          wheelchair_accessible_entrance,
          $10
        ),

      opening_hours_json =
        COALESCE(
          opening_hours_json,
          $11
        ),

      details_fetched_at =
        COALESCE(
          details_fetched_at,
          NOW()
        ),

      updated_at =
        NOW()

    WHERE google_place_id = $12
  `;

  const result =
    await pg.query(
      sql,
      [
        address,
        phone,
        website,
        googleMapsUrl,
        utcOffset,
        delivery,
        dineIn,
        takeout,
        reservable,
        wheelchair,
        openingHoursJson,
        placeId
      ]
    );

  if (
    result.rowCount === 0
  ) {
    console.warn(
      `[WARN] UPDATE 0 rows for place_id=${placeId}`
    );
  }

  console.log(
    `[DETAILS] ${placeId} 補資料完成（原有資料保留）`
  );
}

// ======================================================
// 照片
//
// 原則：
// 1. 原本照片完全不刪
// 2. 原本 photo_reference 已存在 → 不改
// 3. 新 photo_reference → 新增
// ======================================================

async function insertMissingPhotos(
  pg,
  placeId,
  photos
) {
  const restaurantResult =
    await pg.query(
      `
      SELECT id
      FROM restaurants
      WHERE google_place_id = $1
      `,
      [placeId]
    );

  if (
    restaurantResult.rowCount === 0
  ) {
    console.warn(
      `[PHOTO] 找不到餐廳：${placeId}`
    );

    return;
  }

  const restaurantId =
    restaurantResult.rows[0].id;

  // ==================================================
  // Google 沒照片
  //
  // 不做 DELETE
  // 不動原本照片
  // ==================================================

  if (
    !Array.isArray(photos) ||
    photos.length === 0
  ) {
    console.log(
      `[PHOTO] ${placeId} Google 沒回傳照片，原照片全部保留`
    );

    return;
  }

  const sql = `
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

    ON CONFLICT (
      restaurant_id,
      photo_reference
    )

    DO NOTHING
  `;

  let added = 0;
  let skipped = 0;

  for (
    const photo
    of photos.slice(
      0,
      MAX_PHOTOS_PER_PLACE
    )
  ) {
    if (
      !photo.photo_reference
    ) {
      continue;
    }

    const result =
      await pg.query(
        sql,
        [
          restaurantId,
          photo.photo_reference,
          photo.width || null,
          photo.height || null
        ]
      );

    if (
      result.rowCount > 0
    ) {
      added++;
    } else {
      skipped++;
    }
  }

  console.log(
    `[PHOTO] ${placeId} 新增 ${added} 張，原本已有 ${skipped} 張不修改`
  );
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  const pg =
    new Client({
      connectionString:
        DATABASE_URL,

      ssl: {
        rejectUnauthorized:
          false
      }
    });

  await pg.connect();

  console.log(
    "✅ Connected to PostgreSQL"
  );

  try {
    const targets =
      await pickTargets(pg);

    console.log(
      `Targets: ${targets.length}`
    );

    let ok = 0;
    let fail = 0;

    for (
      const target
      of targets
    ) {
      const placeId =
        target.google_place_id;

      const name =
        target.name ||
        placeId;

      console.log("");
      console.log(
        `🔎 處理：${name}`
      );

      try {
        // ===============================================
        // Google Details
        // ===============================================

        const details =
          await fetchPlaceDetails(
            placeId
          );

        await pg.query(
          "BEGIN"
        );

        // ===============================================
        // 只補 NULL 欄位
        // ===============================================

        await updateRestaurantDetails(
          pg,
          details
        );

        // ===============================================
        // 只新增不存在照片
        // ===============================================

        await insertMissingPhotos(
          pg,
          placeId,
          details.photos
        );

        await pg.query(
          "COMMIT"
        );

        ok++;

        console.log(
          `[OK] ${name}`
        );
      } catch (error) {
        fail++;

        try {
          await pg.query(
            "ROLLBACK"
          );
        } catch (_) {}

        console.error(
          `[FAIL] ${name}: ${error.message}`
        );
      }

      await sleep(
        SLEEP_MS
      );
    }

    console.log("");
    console.log(
      "===================================="
    );

    console.log(
      `✅ Done. OK=${ok}, FAIL=${fail}`
    );

    console.log(
      "===================================="
    );
  } finally {
    await pg.end();

    console.log(
      "✅ PostgreSQL disconnected"
    );
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  }
);