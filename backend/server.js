require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const OpenAI = require("openai");
 
const app = express();
 
app.use(cors());
app.use(express.json());
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

async function callGeminiWithRetry(url, data, config, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(url, data, config);
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        const delay = Math.pow(2, i) * 1000;
        console.warn(`⚠️ 429 限流，第 ${i + 1} 次重試，等待 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("重試失敗（429 太多次）");
}

const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in environment");
  process.exit(1);
}
 
if (!GOOGLE_MAPS_API_KEY) {
  console.error("Missing GOOGLE_MAPS_API_KEY in environment");
  process.exit(1);
}
 
 
const PORT = process.env.PORT || 3001;
 
const pg = new Client({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});
 
const FRONTEND_DIR = path.join(__dirname, "..");
app.use(express.static(FRONTEND_DIR));
 
app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});
 
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});
 
/**
 * Google Place Photo Proxy
 */
app.get("/api/photo/:ref", async (req, res) => {
  try {
    const photoRef = req.params.ref;

    if (!GOOGLE_MAPS_API_KEY) {
      console.error("GOOGLE_MAPS_API_KEY is missing");
      return res.status(500).json({
        ok: false,
        error: "GOOGLE_MAPS_API_KEY_MISSING",
      });
    }

    if (!photoRef) {
      return res.status(400).json({
        ok: false,
        error: "PHOTO_REFERENCE_MISSING",
      });
    }

    const maxwidth = req.query.maxwidth
      ? parseInt(req.query.maxwidth, 10)
      : 800;

    const safeMaxWidth = Number.isFinite(maxwidth)
      ? Math.min(Math.max(maxwidth, 100), 1600)
      : 800;

    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/place/photo",
      {
        params: {
          maxwidth: safeMaxWidth,
          photo_reference: photoRef,
          key: GOOGLE_MAPS_API_KEY,
        },
        responseType: "stream",
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
      }
    );

    if (response.headers["content-type"]) {
      res.setHeader("Content-Type", response.headers["content-type"]);
    }

    res.setHeader("Cache-Control", "public, max-age=86400");

    response.data.pipe(res);
  } catch (err) {
    console.error("GET /api/photo/:ref error:", err.message);

    if (err.response) {
      console.error("status:", err.response.status);
      console.error("headers:", err.response.headers);
    }

    res.status(502).json({
      ok: false,
      error: "PHOTO_FETCH_FAILED",
    });
  }
});
 
// GET /api/restaurants
app.get("/api/restaurants", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const open = req.query.open === "true";
    const tag = (req.query.tag || "").trim();
    const parsedLimit = parseInt(req.query.limit || "500", 10);

    const limit = Number.isFinite(parsedLimit)
  ? Math.max(parsedLimit, 1)
  : 500;
    const sort = req.query.sort || "rating";
 
    const where = [];
    const params = [];
    let i = 1;
 
    if (q) {
      where.push(`r.name ILIKE $${i++}`);
      params.push(`%${q}%`);
    }
 
    if (open) {
      where.push(`r.opening_now = true`);
    }

    if (tag) {
      where.push(`$${i++} = ANY(r.tags)`);
      params.push(tag);
    }
 
    const orderBy =
      sort === "reviews"
        ? "r.user_ratings_total DESC NULLS LAST"
        : sort === "price"
        ? "r.price_level ASC NULLS LAST"
        : "r.rating DESC NULLS LAST";
 
    const sql = `
      SELECT
        r.id,
        r.google_place_id,
        r.name,
        r.address,
        r.lat,
        r.lng,
        r.rating,
        r.user_ratings_total,
        r.price_level,
        r.opening_now,
        r.opening_hours_json,
        r.business_status,
        r.phone,
        r.website,
        r.google_maps_url,
        r.delivery,
        r.dine_in,
        r.takeout,
        r.reservable,
        r.wheelchair_accessible_entrance,
        r.details_fetched_at,
        r.tags,
        (
          SELECT p.image_url
          FROM restaurant_photos p
          WHERE p.restaurant_id = r.id
            AND p.image_url IS NOT NULL
          ORDER BY p.id ASC
          LIMIT 1
        ) AS image_url
      FROM restaurants r
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${orderBy}
      LIMIT $${i++}
    `;
 
    params.push(limit);
 
    const result = await pg.query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("GET /api/restaurants error:", err.message);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});
 
// GET /api/restaurants/:id
app.get("/api/restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
 
    const r = await pg.query(
      `SELECT r.* FROM restaurants r WHERE r.id = $1`,
      [id]
    );
 
    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
 
    const store = r.rows[0];
 
    const p = await pg.query(
      `
      SELECT image_url
      FROM restaurant_photos
      WHERE restaurant_id = $1
        AND image_url IS NOT NULL
      ORDER BY id ASC
      LIMIT 10
      `,
      [id]
    );
 
    store.photos = p.rows;
 
    res.json({ ok: true, data: store });
  } catch (err) {
    console.error("GET /api/restaurants/:id error:", err.message);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ============================================================
// ⭐ Google Maps 評論
// PostgreSQL 快取版
//
// 流程：
// 1. 先讀 PostgreSQL
// 2. 7 天內 → 直接使用 DB
// 3. 超過 7 天 / 沒資料 → 呼叫 Google API
// 4. 將最新結果寫回 PostgreSQL
// ============================================================

app.get(
  "/api/restaurants/:id/google-reviews",
  async (req, res) => {

    try {

      const restaurantId =
        Number(req.params.id);


      if (
        !Number.isInteger(restaurantId)
      ) {

        return res.status(400).json({
          ok: false,
          error: "餐廳編號格式錯誤"
        });

      }


      // ========================================================
      // 1. 先查 Google 評論快取
      // ========================================================

      const cacheResult =
        await pg.query(
          `
          SELECT
            restaurant_id,
            rating,
            total_reviews,
            google_maps_uri,
            reviews_json,
            fetched_at

          FROM google_reviews_cache

          WHERE restaurant_id = $1

          LIMIT 1
          `,
          [restaurantId]
        );


      if (
        cacheResult.rows.length > 0
      ) {

        const cache =
          cacheResult.rows[0];


        const fetchedAt =
          new Date(
            cache.fetched_at
          );


        const now =
          new Date();


        const age =
          now.getTime() -
          fetchedAt.getTime();


        // ⭐ 7 天
        const CACHE_TIME =
          7 *
          24 *
          60 *
          60 *
          1000;


        // ======================================================
        // 快取還沒過期
        // ======================================================

        if (
          age < CACHE_TIME
        ) {

          console.log(
            `💾 Google 評論使用 DB 快取：餐廳 ${restaurantId}`
          );


          return res.json({

            ok: true,

            rating:
              cache.rating !== null
                ? Number(cache.rating)
                : null,

            totalReviews:
              cache.total_reviews || 0,

            googleMapsUri:
              cache.google_maps_uri ||
              null,

            reviews:
              cache.reviews_json ||
              [],

            cache: true,

            fetchedAt:
              cache.fetched_at

          });

        }


        console.log(
          `♻️ Google 評論快取已超過 7 天：餐廳 ${restaurantId}`
        );

      }


      // ========================================================
      // 2. 查餐廳
      // ========================================================

      const restaurantResult =
        await pg.query(
          `
          SELECT
            id,
            name,
            google_place_id

          FROM restaurants

          WHERE id = $1

          LIMIT 1
          `,
          [restaurantId]
        );


      if (
        restaurantResult.rows.length === 0
      ) {

        return res.status(404).json({
          ok: false,
          error: "找不到這間餐廳"
        });

      }


      const restaurant =
        restaurantResult.rows[0];


      if (
        !restaurant.google_place_id
      ) {

        return res.status(404).json({
          ok: false,
          error:
            "這間餐廳沒有 Google Place ID"
        });

      }


      // ========================================================
      // 3. 呼叫 Google Places API
      // ========================================================

      console.log(
        `🌐 呼叫 Google Places API：${restaurant.name}`
      );


      const placeId =
        restaurant.google_place_id;


      const googleResponse =
        await axios.get(

          `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,

          {

            headers: {

              "X-Goog-Api-Key":
                GOOGLE_MAPS_API_KEY,


              "X-Goog-FieldMask": [
                "displayName",
                "rating",
                "userRatingCount",
                "reviews",
                "googleMapsUri"
              ].join(",")

            },


            params: {

              languageCode:
                "zh-TW"

            },


            timeout:
              15000

          }

        );


      const place =
        googleResponse.data;


      // ========================================================
      // 4. 整理 Google 評論
      // ========================================================

      const reviews =
        Array.isArray(
          place.reviews
        )

          ? place.reviews.map(
              review => ({

                author_name:
                  review
                    .authorAttribution
                    ?.displayName ||
                  "Google 使用者",


                author_uri:
                  review
                    .authorAttribution
                    ?.uri ||
                  null,


                author_photo_uri:
                  review
                    .authorAttribution
                    ?.photoUri ||
                  null,


                rating:
                  review.rating ??
                  null,


                text:
                  review.text?.text ||
                  review.originalText
                    ?.text ||
                  "",


                relative_time:
                  review
                    .relativePublishTimeDescription ||
                  null,


                publish_time:
                  review.publishTime ||
                  null,


                google_maps_uri:
                  review.googleMapsUri ||
                  place.googleMapsUri ||
                  null

              })
            )

          : [];


      // ========================================================
      // 5. 存進 PostgreSQL
      // ========================================================

      await pg.query(
        `
        INSERT INTO google_reviews_cache (
          restaurant_id,
          rating,
          total_reviews,
          google_maps_uri,
          reviews_json,
          fetched_at
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          NOW()
        )

        ON CONFLICT (restaurant_id)

        DO UPDATE SET

          rating =
            EXCLUDED.rating,

          total_reviews =
            EXCLUDED.total_reviews,

          google_maps_uri =
            EXCLUDED.google_maps_uri,

          reviews_json =
            EXCLUDED.reviews_json,

          fetched_at =
            NOW()
        `,
        [
          restaurantId,

          place.rating ??
            null,

          place.userRatingCount ??
            0,

          place.googleMapsUri ||
            null,

          JSON.stringify(
            reviews
          )
        ]
      );


      console.log(
        `✅ Google 評論已存入 DB：${restaurant.name}`
      );


      // ========================================================
      // 6. 回傳給前端
      // ========================================================

      return res.json({

        ok: true,


        restaurant: {

          id:
            restaurant.id,

          name:
            restaurant.name

        },


        rating:
          place.rating ??
          null,


        totalReviews:
          place.userRatingCount ??
          0,


        googleMapsUri:
          place.googleMapsUri ||
          null,


        reviews,


        cache: false,


        fetchedAt:
          new Date().toISOString()

      });


    } catch (error) {

      console.error(
        "🔴 Google 評論取得失敗：",
        error.response?.data ||
        error.message
      );


      if (
        error.response
      ) {

        return res
          .status(
            error.response.status ||
            502
          )
          .json({

            ok: false,

            error:
              "Google 評論取得失敗",

            googleError:
              error.response
                .data
                ?.error
                ?.message ||
              error.response
                .data
                ?.error ||
              null

          });

      }


      return res
        .status(500)
        .json({

          ok: false,

          error:
            "Google 評論取得失敗"

        });

    }

  }
);
 
async function start() {
  try {
    await pg.connect();
    console.log("✅ Connected to PostgreSQL");
  } catch (e) {
    console.error("❌ Failed to connect PostgreSQL:", e.message);
    process.exit(1);
  }
 
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Health check: /api/health`);
    console.log(`✅ Restaurants: /api/restaurants`);
    console.log(`✅ Photo proxy: /api/photo/<photo_reference>?maxwidth=800`);
    console.log(`✅ AI chat (Gemini): POST /api/chat`);
    console.log("✅ Post Like: POST /api/posts/:postId/like");
  });
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key";

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, nickname, password, phone } = req.body;

    // 1. 檢查必填欄位
    if (!username || !nickname || !password || !phone) {
      return res.json({ ok: false, error: "請填寫所有欄位 (包含帳號、暱稱、密碼與手機)" });
    }

    // 2. 帳號格式驗證 (8 位純數字)
    const usernameRegex = /^[0-9]{8}$/;
    if (!usernameRegex.test(username)) {
      return res.json({ ok: false, error: "帳號格式錯誤：必須為 8 個純數字" });
    }

    // 3. 暱稱格式驗證
    const cleanNickname = nickname.trim();
    if (cleanNickname.length < 1 || cleanNickname.length > 20) {
      return res.json({ ok: false, error: "暱稱長度必須在 1 ~ 20 個字之間" });
    }

    // 4. 密碼格式驗證 (4~10 位英數字)
    const passwordRegex = /^[a-zA-Z0-9]{4,10}$/;
    if (!passwordRegex.test(password)) {
      return res.json({ ok: false, error: "密碼格式錯誤：必須為 4~10 個英數字" });
    }

    // 5. 新增：手機號碼格式驗證
    const phoneRegex = /^09\d{8}$/;
    if (!phoneRegex.test(phone)) {
      return res.json({ ok: false, error: "手機號碼格式錯誤：必須為 09 開頭的 10 位數字" });
    }

    // 6. 檢查帳號是否已被註冊
    const exists = await pg.query("SELECT id FROM users WHERE username = $1", [username]);
    if (exists.rows.length > 0) {
      return res.json({ ok: false, error: "這個帳號已經被註冊" });
    }

    // 7. 檢查手機號碼是否已被使用 (防呆，避免同號碼註冊多帳號)
    const phoneExists = await pg.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (phoneExists.rows.length > 0) {
      return res.json({ ok: false, error: "這個手機號碼已經被註冊過了" });
    }

    // 8. 密碼 Hash 加密
    const passwordHash = await bcrypt.hash(password, 10);

    // 9. 寫入資料庫 (包含 phone 欄位)
    await pg.query(
      "INSERT INTO users (username, nickname, password_hash, phone) VALUES ($1, $2, $3, $4)",
      [username, cleanNickname, passwordHash, phone]
    );

    res.json({ ok: true, message: "註冊成功" });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ ok: false, error: "註冊失敗" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({ ok: false, error: "請輸入帳號和密碼" });
    }

    const result = await pg.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: "帳號不存在，請先註冊" });
    }

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.json({ ok: false, error: "密碼錯誤" });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      ok: true,
      message: "登入成功",
      token,
      username: user.username,
      nickname: user.nickname,
    });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ ok: false, error: "登入失敗" });
  }
});


// ==========================================
// 忘記密碼 (重設密碼) - 帳號+電話直接修改
// ==========================================
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { username, phone, newPassword } = req.body;

    if (!username || !phone || !newPassword) {
      return res.json({ ok: false, error: "請填寫所有欄位" });
    }

    // 1. 驗證新密碼格式
    const passwordRegex = /^[a-zA-Z0-9]{4,10}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.json({ ok: false, error: "新密碼格式錯誤：必須為 4~10 個英數字" });
    }

    // 2. 比對資料庫，確認帳號與手機號碼是否完全吻合
    const result = await pg.query(
      "SELECT id FROM users WHERE username = $1 AND phone = $2",
      [username, phone]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: "帳號與手機號碼不符，或帳號不存在" });
    }

    // 3. 驗證通過，將新密碼進行 Hash 加密
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // 4. 更新該使用者的密碼
    await pg.query(
      "UPDATE users SET password_hash = $1 WHERE username = $2",
      [passwordHash, username]
    );

    res.json({ ok: true, message: "密碼重設成功！請使用新密碼登入" });
  } catch (err) {
    console.error("reset password error:", err);
    res.status(500).json({ ok: false, error: "重設密碼失敗，請稍後再試" });
  }
});


function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ ok: false, error: "尚未登入" });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "登入已過期，請重新登入" });
  }
}

// ============================================================
// 👤 取得目前登入使用者資料
// ============================================================

app.get(
  "/api/users/me",
  authMiddleware,
  async (req, res) => {

    try {

      const userId =
        req.user.userId;

      const result =
        await pg.query(
          `
          SELECT
            id,
            username,
            nickname,
            phone

          FROM users

          WHERE id = $1
          `,
          [userId]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          ok: false,
          error: "找不到使用者"
        });
      }


      return res.json({
        ok: true,
        user: result.rows[0]
      });


    } catch (error) {

      console.error(
        "取得使用者資料失敗:",
        error
      );


      return res.status(500).json({
        ok: false,
        error: "取得使用者資料失敗"
      });
    }
  }
);

// ============================================================
// 👤 修改目前登入使用者資料
// ============================================================

// ============================================================
// 👤 修改目前登入使用者資料
// ============================================================

app.put(
  "/api/users/me",
  authMiddleware,
  async (req, res) => {

    try {

      const userId =
        req.user.userId;


      const nickname =
        String(
          req.body.nickname || ""
        ).trim();


      const phone =
        String(
          req.body.phone || ""
        ).trim();


      // ==============================
      // 暱稱
      // ==============================

      if (!nickname) {

        return res.status(400).json({
          ok: false,
          error: "暱稱不能為空白"
        });
      }


      if (
        nickname.length < 1 ||
        nickname.length > 20
      ) {

        return res.status(400).json({
          ok: false,
          error: "暱稱必須為 1～20 個字"
        });
      }


      // ==============================
      // 手機號碼
      // ==============================

      if (!/^09\d{8}$/.test(phone)) {

        return res.status(400).json({
          ok: false,
          error:
            "手機號碼必須為 09 開頭的 10 位數字"
        });
      }


      // ==============================
      // 確認電話沒有被別人使用
      // ==============================

      const phoneExists =
        await pg.query(
          `
          SELECT id

          FROM users

          WHERE phone = $1
            AND id != $2

          LIMIT 1
          `,
          [
            phone,
            userId
          ]
        );


      if (
        phoneExists.rows.length > 0
      ) {

        return res.status(409).json({
          ok: false,
          error:
            "這個手機號碼已經被其他帳號使用"
        });
      }


      // ==============================
      // 更新
      // ==============================

      const result =
        await pg.query(
          `
          UPDATE users

          SET
            nickname = $1,
            phone = $2

          WHERE id = $3

          RETURNING
            id,
            username,
            nickname,
            phone
          `,
          [
            nickname,
            phone,
            userId
          ]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          ok: false,
          error: "找不到使用者"
        });
      }


      return res.json({
        ok: true,
        message: "個人資料更新成功",
        user: result.rows[0]
      });


    } catch (error) {

      console.error(
        "更新使用者資料失敗:",
        error
      );


      return res.status(500).json({
        ok: false,
        error: "更新使用者資料失敗"
      });
    }
  }
);

// ==========================================
// 🎯 餐廳備忘錄功能 (Memos API)
// ==========================================

// 1. 讀取備忘錄 (GET)
app.get(
  "/api/restaurants/:restaurantId/memo",
  authMiddleware, // 🔒 帶入驗證中間件
  async (req, res) => {
    try {
      // 🎯 關鍵修復：相容不同的 key 命名，確保能抓到 userId
      const userId = req.user?.id || req.user?.userId || req.user?.id_user;
      const restaurantId = Number(req.params.restaurantId);

      // 安全防呆：檢查是否成功取得使用者 ID
      if (!userId) {
        return res.status(401).json({ ok: false, error: "未登入或身份驗證失敗，請重新登入" });
      }

      // 安全防呆：檢查餐廳 ID 是否為整數
      if (!Number.isInteger(restaurantId)) {
        return res.status(400).json({ ok: false, error: "餐廳編號格式錯誤" });
      }

      // 🔍 使用 pg.query 進行資料庫查詢
      const result = await pg.query(
        `
        SELECT id, content, created_at, updated_at 
        FROM restaurant_memos 
        WHERE user_id = $1 AND restaurant_id = $2
        `,
        [userId, restaurantId]
      );

      // 如果該會員還沒對這家餐廳寫過備忘錄，回傳空字串
      if (result.rows.length === 0) {
        return res.json({
          ok: true,
          memo: null,
          content: ""
        });
      }

      // 成功找到備忘錄
      res.json({
        ok: true,
        memo: result.rows[0],
        content: result.rows[0].content
      });
    } catch (error) {
      console.error("🔴 讀取備忘錄失敗：", error);
      res.status(500).json({ ok: false, error: "伺服器內部錯誤" });
    }
  }
);

// 2. 新增或修改備忘錄 (PUT) - 採用 Upsert 邏輯
app.put(
  "/api/restaurants/:restaurantId/memo",
  authMiddleware, // 🔒 帶入驗證中間件
  async (req, res) => {
    try {
      // 🎯 關鍵修復：相容不同的 key 命名，避免傳 null 給資料庫
      const userId = req.user?.id || req.user?.userId || req.user?.id_user;
      const restaurantId = Number(req.params.restaurantId);
      const { content } = req.body;

      // 安全防呆：檢查是否成功取得使用者 ID
      if (!userId) {
        return res.status(401).json({ ok: false, error: "未登入或身份驗證失敗，請重新登入" });
      }

      // 安全防呆
      if (!Number.isInteger(restaurantId)) {
        return res.status(400).json({ ok: false, error: "餐廳編號格式錯誤" });
      }

      if (typeof content !== "string") {
        return res.status(400).json({ ok: false, error: "備忘錄內容格式錯誤" });
      }

      // 🔍 使用 pg.query 執行 Upsert
      const result = await pg.query(
        `
        INSERT INTO restaurant_memos (user_id, restaurant_id, content)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, restaurant_id)
        DO UPDATE SET
          content = EXCLUDED.content,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
        `,
        [userId, restaurantId, content.trim()]
      );

      res.json({
        ok: true,
        message: "備忘錄已儲存",
        memo: result.rows[0]
      });
    } catch (error) {
      console.error("🔴 儲存備忘錄失敗：", error);
      res.status(500).json({ 
        ok: false, 
        error: `SQL錯誤：${error.message}` 
      });
    }
  }
);

// ==========================================
// 💬 餐廳匿名評論功能 Comments API
// ==========================================

// 1. 取得某間餐廳所有評論
// 不需要登入，所有人都可以查看
app.get(
  "/api/restaurants/:restaurantId/comments",
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.restaurantId);

      // 檢查餐廳 ID
      if (!Number.isInteger(restaurantId)) {
        return res.status(400).json({
          ok: false,
          error: "餐廳編號格式錯誤"
        });
      }

      // 確認餐廳存在
      const restaurantCheck = await pg.query(
        `
        SELECT id
        FROM restaurants
        WHERE id = $1
        `,
        [restaurantId]
      );

      if (restaurantCheck.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到這間餐廳"
        });
      }

      // 取得評論
      const result = await pg.query(
        `
        SELECT
          id,
          content,
          created_at
        FROM restaurant_comments
        WHERE restaurant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 50
        `,
        [restaurantId]
      );

      // 不把 user_id 傳給前端
      // 所有留言統一顯示匿名使用者
      const comments = result.rows.map((comment) => ({
        id: comment.id,
        nickname: "匿名使用者",
        content: comment.content,
        created_at: comment.created_at
      }));

      res.json({
        ok: true,
        comments
      });

    } catch (error) {
      console.error("🔴 讀取評論失敗：", error);

      res.status(500).json({
        ok: false,
        error: "讀取評論失敗"
      });
    }
  }
);


// ==========================================
// 2. 新增匿名評論
// 必須登入才能發表
// ==========================================

app.post(
  "/api/restaurants/:restaurantId/comments",
  authMiddleware,
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.restaurantId);

      const userId =
        req.user?.id ||
        req.user?.userId ||
        req.user?.id_user;

      const { content } = req.body;

      // -----------------------------
      // 檢查會員
      // -----------------------------
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: "請先登入"
        });
      }

      // -----------------------------
      // 檢查餐廳 ID
      // -----------------------------
      if (!Number.isInteger(restaurantId)) {
        return res.status(400).json({
          ok: false,
          error: "餐廳編號格式錯誤"
        });
      }

      // -----------------------------
      // 檢查評論內容
      // -----------------------------
      if (typeof content !== "string") {
        return res.status(400).json({
          ok: false,
          error: "評論內容格式錯誤"
        });
      }

      const cleanContent = content.trim();

      if (cleanContent.length < 3) {
        return res.status(400).json({
          ok: false,
          error: "評論至少需要 3 個字"
        });
      }

      if (cleanContent.length > 300) {
        return res.status(400).json({
          ok: false,
          error: "評論最多 300 個字"
        });
      }

      // -----------------------------
      // 確認餐廳存在
      // -----------------------------
      const restaurantCheck = await pg.query(
        `
        SELECT id
        FROM restaurants
        WHERE id = $1
        `,
        [restaurantId]
      );

      if (restaurantCheck.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到這間餐廳"
        });
      }

      // -----------------------------
      // 防止狂洗留言
      // 同一會員 1 分鐘只能留言一次
      // -----------------------------
      const timeCheck = await pg.query(
        `
        SELECT created_at
        FROM restaurant_comments
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [userId]
      );

      if (timeCheck.rows.length > 0) {
        const lastTime =
          new Date(timeCheck.rows[0].created_at).getTime();

        const now = Date.now();

        if (now - lastTime < 60 * 1000) {
          return res.status(429).json({
            ok: false,
            error: "發言太頻繁，請等 1 分鐘再試"
          });
        }
      }

      // -----------------------------
      // 新增評論
      // -----------------------------
      const result = await pg.query(
        `
        INSERT INTO restaurant_comments
        (
          restaurant_id,
          user_id,
          content
        )
        VALUES ($1, $2, $3)
        RETURNING
          id,
          content,
          created_at
        `,
        [
          restaurantId,
          userId,
          cleanContent
        ]
      );

      const comment = result.rows[0];

      // -----------------------------
      // 回傳給前端
      // -----------------------------
      res.status(201).json({
        ok: true,
        message: "匿名評論發表成功！",
        comment: {
          id: comment.id,
          nickname: "匿名使用者",
          content: comment.content,
          created_at: comment.created_at
        }
      });

    } catch (error) {
      console.error("🔴 新增評論失敗：", error);

      res.status(500).json({
        ok: false,
        error: "新增評論失敗"
      });
    }
  }
);

// 取得我的收藏
app.get("/api/favorites", authMiddleware, async (req, res) => {
  try {
    const result = await pg.query(
      "SELECT restaurant_id FROM user_favorites WHERE user_id = $1",
      [req.user.userId]
    );

    res.json({
      ok: true,
      data: result.rows.map(row => row.restaurant_id)
    });
  } catch (err) {
    console.error("GET /api/favorites error:", err);
    res.status(500).json({ ok: false, error: "取得收藏失敗" });
  }
});

// 加入收藏
app.post("/api/favorites/:restaurantId", authMiddleware, async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId);

    await pg.query(
      `
      INSERT INTO user_favorites (user_id, restaurant_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, restaurant_id) DO NOTHING
      `,
      [req.user.userId, restaurantId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/favorites error:", err);
    res.status(500).json({ ok: false, error: "加入收藏失敗" });
  }
});

// 取消收藏
app.delete("/api/favorites/:restaurantId", authMiddleware, async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId);

    await pg.query(
      "DELETE FROM user_favorites WHERE user_id = $1 AND restaurant_id = $2",
      [req.user.userId, restaurantId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/favorites error:", err);
    res.status(500).json({ ok: false, error: "取消收藏失敗" });
  }
});



const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- 1. 修改原本的 GPT API：加入寫入資料庫邏輯與後端 Prompt ---
app.post("/api/gpt", async (req, res) => {
  try {
    const { question, contextStores, conversationId } = req.body;
    let currentConvId = conversationId;

    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (err) {
        console.warn("Token 無效或過期，視為未登入訪客");
      }
    }

    const systemPrompt = `
    你是一個中原大學周邊的美食推薦助手。請根據【使用者的問題】以及下方的【目前餐廳清單】，推薦「3到5家」符合條件的餐廳，並用親切的語氣簡短說明推薦原因，整體回覆請控制在100字以內。
    
    重要規定：
    1. 為了讓系統自動幫使用者過濾畫面，請務必在你回覆的「最後獨立一行」加上指令標籤，並用「|」符號隔開你推薦的餐廳名稱。例如：<<<SEARCH:大四喜腿庫飯|豚將拉麵|麥當勞>>>。
    2. 只回答餐廳、美食、飲料相關問題，只能推薦中原大學附近店家。
    3. 如果【使用者的問題】中有提到餐廳以外的提問請自動忽略不要回應，或直接回答：與餐廳無關，請重新提問。
    4. 用白話文，不要解釋太多，直接講重點。
    `;

    // 將清單與問題組合成 User 角色傳給 AI
    const userMessage = `
    【目前餐廳清單】：
    ${contextStores}

    【使用者的問題】：${question}
    `;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage } 
      ]
    });

    const replyText = response.output_text.trim();

    // 如果使用者有登入，才進行資料庫紀錄
    if (userId) {
      // 若沒有對話 ID，代表是第一次發問，建立一個新聊天室
      if (!currentConvId) {
        const title = question.substring(0, 30); // 拿問題的前 30 個字當標題
        const convResult = await pg.query(
          "INSERT INTO ai_conversations (user_id, title) VALUES ($1, $2) RETURNING id",
          [userId, title]
        );
        currentConvId = convResult.rows[0].id;
      }

      // 寫入使用者的問題 (存入純淨的 question)
      await pg.query(
        "INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [currentConvId, "user", question]
      );

      // 寫入 AI 的回答
      await pg.query(
        "INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [currentConvId, "assistant", replyText]
      );
    }

    // 將 AI 回覆與當前的對話 ID 傳回給前端
    res.json({
      ok: true,
      reply: replyText,
      conversationId: currentConvId
    });

  } catch (err) {
    console.error("GPT error:", err);
    res.status(500).json({ ok: false, error: "GPT_FAILED" });
  }
});

// --- 2. 取得使用者的歷史對話清單 (更新：加入 is_favorite) ---
app.get("/api/ai/conversations", authMiddleware, async (req, res) => {
  try {
    // 利用子查詢 (Subquery) 撈出該對話中 AI 的第一筆回覆
    const result = await pg.query(
      `SELECT 
         c.id, 
         c.title, 
         c.created_at, 
         c.is_favorite,
         (SELECT m.content FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' ORDER BY m.id ASC LIMIT 1) as ai_reply
       FROM ai_conversations c 
       WHERE c.user_id = $1 
       ORDER BY c.created_at DESC`,
      [req.user.userId]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("Fetch conversations error:", err);
    res.status(500).json({ ok: false, error: "無法取得歷史對話" });
  }
});

// --- 新增 API：切換對話的收藏狀態 (is_favorite) ---
app.put("/api/ai/conversations/:id/favorite", authMiddleware, async (req, res) => {
  try {
    const convId = req.params.id;
    const userId = req.user.userId;
    const { is_favorite } = req.body;

    await pg.query(
      "UPDATE ai_conversations SET is_favorite = $1 WHERE id = $2 AND user_id = $3",
      [is_favorite, convId, userId]
    );

    res.json({ ok: true, message: "收藏狀態已更新" });
  } catch (err) {
    console.error("Favorite update error:", err);
    res.status(500).json({ ok: false, error: "更新收藏狀態失敗" });
  }
});

// --- 3. 新增 API：取得特定聊天室的詳細對話 ---
app.get("/api/ai/conversations/:id", authMiddleware, async (req, res) => {
  try {
    const result = await pg.query(
      "SELECT role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY id ASC",
      [req.params.id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("Fetch messages error:", err);
    res.status(500).json({ ok: false, error: "無法取得對話內容" });
  }
});

// --- 4. 新增 API：刪除特定聊天紀錄 ---
app.delete("/api/ai/conversations/:id", authMiddleware, async (req, res) => {
  try {
    const convId = req.params.id;
    const userId = req.user.userId;

    // 1. 先安全檢查：確認這筆對話存在，而且是屬於現在這位登入使用者的
    const check = await pg.query(
      "SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2",
      [convId, userId]
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ ok: false, error: "無權限刪除或找不到該筆對話" });
    }

    // 2. 先刪除 ai_messages 裡面的對話內容 
    // (這步很重要，如果沒有設定資料庫的 CASCADE，直接刪除主表會因為關聯性報錯)
    await pg.query("DELETE FROM ai_messages WHERE conversation_id = $1", [convId]);

    // 3. 再刪除 ai_conversations 裡的對話列表 (主表)
    await pg.query("DELETE FROM ai_conversations WHERE id = $1", [convId]);

    res.json({ ok: true, message: "對話刪除成功" });
  } catch (err) {
    console.error("Delete conversation error:", err);
    res.status(500).json({ ok: false, error: "伺服器刪除失敗" });
  }
});
// ============================================================
// 👥 好友功能 API
// ============================================================


// ============================================================
// 1. 搜尋使用者
// username = 8 位數帳號 / 學號
// ============================================================
app.get("/api/friends/search", authMiddleware, async (req, res) => {
  try {
    const studentId = String(req.query.studentId || "").trim();
    const currentUserId = req.user.userId;

    if (!studentId) {
      return res.status(400).json({
        ok: false,
        error: "請提供學號進行搜尋"
      });
    }

    // 搜尋其他使用者
    const userResult = await pg.query(
      `
      SELECT
        id,
        username AS student_id,
        nickname
      FROM users
      WHERE username = $1
        AND id != $2
      `,
      [studentId, currentUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "找不到該學號的使用者"
      });
    }

    const targetUser = userResult.rows[0];

    // 查看目前兩人的好友狀態
    const statusResult = await pg.query(
      `
      SELECT
        id,
        requester_id,
        receiver_id,
        status
      FROM user_friends
      WHERE
        (requester_id = $1 AND receiver_id = $2)
        OR
        (requester_id = $2 AND receiver_id = $1)
      ORDER BY id DESC
      LIMIT 1
      `,
      [currentUserId, targetUser.id]
    );

    let friendshipStatus = "NONE";
    let friendshipId = null;

    if (statusResult.rows.length > 0) {
      // 資料庫是 pending / accepted / rejected
      // 前端目前使用 PENDING / ACCEPTED
      friendshipStatus = String(
        statusResult.rows[0].status
      ).toUpperCase();

      friendshipId = statusResult.rows[0].id;
    }

    return res.json({
      ok: true,
      user: targetUser,
      friendshipStatus,
      friendshipId
    });

  } catch (error) {
    console.error("搜尋使用者失敗:", error);

    return res.status(500).json({
      ok: false,
      error: "搜尋使用者失敗"
    });
  }
});


// ============================================================
// 2. 發送好友邀請
// ============================================================
app.post("/api/friends/request", authMiddleware, async (req, res) => {
  try {
    const requesterId = req.user.userId;
    const targetUserId = Number(req.body.targetUserId);

    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({
        ok: false,
        error: "目標使用者 ID 不正確"
      });
    }

    // 不能加自己
    if (requesterId === targetUserId) {
      return res.status(400).json({
        ok: false,
        error: "無法新增自己為好友"
      });
    }

    // 確認對方存在
    const targetCheck = await pg.query(
      `
      SELECT id
      FROM users
      WHERE id = $1
      `,
      [targetUserId]
    );

    if (targetCheck.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "找不到該使用者"
      });
    }

    // 查詢兩人是否已有好友關係
    const checkResult = await pg.query(
      `
      SELECT *
      FROM user_friends
      WHERE
        (requester_id = $1 AND receiver_id = $2)
        OR
        (requester_id = $2 AND receiver_id = $1)
      ORDER BY id DESC
      LIMIT 1
      `,
      [requesterId, targetUserId]
    );

    if (checkResult.rows.length > 0) {
      const existing = checkResult.rows[0];

      if (existing.status === "accepted") {
        return res.status(400).json({
          ok: false,
          error: "你們已經是好友了"
        });
      }

      if (existing.status === "pending") {
        return res.status(400).json({
          ok: false,
          error: "已有待處理的好友邀請"
        });
      }

      // 如果之前被拒絕，可以重新發送
      if (existing.status === "rejected") {
        const resetResult = await pg.query(
          `
          UPDATE user_friends
          SET
            requester_id = $1,
            receiver_id = $2,
            status = 'pending',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING *
          `,
          [
            requesterId,
            targetUserId,
            existing.id
          ]
        );

        return res.json({
          ok: true,
          message: "好友邀請已重新發送！",
          friendship: resetResult.rows[0]
        });
      }
    }

    // 第一次發送邀請
    const newFriendship = await pg.query(
      `
      INSERT INTO user_friends
        (
          requester_id,
          receiver_id,
          status
        )
      VALUES
        (
          $1,
          $2,
          'pending'
        )
      RETURNING *
      `,
      [
        requesterId,
        targetUserId
      ]
    );

    return res.status(201).json({
      ok: true,
      message: "好友邀請已發送！",
      friendship: newFriendship.rows[0]
    });

  } catch (error) {
    console.error("發送好友邀請失敗:", error);

    return res.status(500).json({
      ok: false,
      error: "發送好友邀請失敗"
    });
  }
});


// ============================================================
// 3. 取得我收到的好友申請
// ============================================================
app.get("/api/friends/requests", authMiddleware, async (req, res) => {
  try {
    const myUserId = req.user.userId;

    const result = await pg.query(
      `
      SELECT
        f.id AS friendship_id,
        f.created_at,

        u.id AS user_id,
        u.username AS student_id,
        u.nickname

      FROM user_friends f

      JOIN users u
        ON u.id = f.requester_id

      WHERE
        f.receiver_id = $1
        AND f.status = 'pending'

      ORDER BY f.created_at DESC
      `,
      [myUserId]
    );

    return res.json({
      ok: true,
      requests: result.rows
    });

  } catch (error) {
    console.error(
      "取得好友申請列表失敗:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "取得好友申請失敗"
    });
  }
});


// ============================================================
// 4. 同意 / 拒絕好友邀請
//
// 前端傳：
// ACCEPT
// REJECT
//
// DB 存：
// accepted
// rejected
// ============================================================
app.put("/api/friends/respond", authMiddleware, async (req, res) => {
  try {
    const myUserId = req.user.userId;

    const friendshipId =
      Number(req.body.friendshipId);

    const action =
      req.body.action;

    if (
      !Number.isInteger(friendshipId) ||
      !["ACCEPT", "REJECT"].includes(action)
    ) {
      return res.status(400).json({
        ok: false,
        error: "參數不正確"
      });
    }

    // 只能處理寄給自己的邀請
    const checkResult = await pg.query(
      `
      SELECT *
      FROM user_friends
      WHERE
        id = $1
        AND receiver_id = $2
        AND status = 'pending'
      `,
      [
        friendshipId,
        myUserId
      ]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "找不到該好友邀請，或您無權操作"
      });
    }

    const newStatus =
      action === "ACCEPT"
        ? "accepted"
        : "rejected";

    const updatedResult = await pg.query(
      `
      UPDATE user_friends
      SET
        status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        newStatus,
        friendshipId
      ]
    );

    return res.json({
      ok: true,

      message:
        action === "ACCEPT"
          ? "已同意成為好友！"
          : "已拒絕好友邀請",

      friendship: updatedResult.rows[0]
    });

  } catch (error) {
    console.error(
      "處理好友邀請失敗:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "處理好友邀請失敗"
    });
  }
});


// ============================================================
// 5. 取得我的好友列表
// ============================================================
app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const myUserId = req.user.userId;

    const result = await pg.query(
      `
      SELECT
        f.id AS friendship_id,

        u.id AS user_id,
        u.username AS student_id,
        u.nickname

      FROM user_friends f

      JOIN users u
        ON u.id =
          CASE
            WHEN f.requester_id = $1
              THEN f.receiver_id
            ELSE f.requester_id
          END

      WHERE
        (
          f.requester_id = $1
          OR
          f.receiver_id = $1
        )

        AND f.status = 'accepted'

      ORDER BY u.nickname ASC
      `,
      [myUserId]
    );

    return res.json({
      ok: true,
      friends: result.rows
    });

  } catch (error) {
    console.error(
      "取得好友列表失敗:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "取得好友列表失敗"
    });
  }
});

// ============================================================
// 🗑️ 刪除好友
// ============================================================

app.delete(
  "/api/friends/:friendshipId",
  authMiddleware,
  async (req, res) => {
    try {

      const myUserId =
        req.user.userId;

      const friendshipId =
        Number(req.params.friendshipId);

      if (!Number.isInteger(friendshipId)) {
        return res.status(400).json({
          ok: false,
          error: "好友關係 ID 格式錯誤"
        });
      }


      // 先確認：
      // 1. 這筆好友關係存在
      // 2. 自己確實是其中一方
      // 3. 狀態為 accepted
      const checkResult =
        await pg.query(
          `
          SELECT
            id,
            requester_id,
            receiver_id
          FROM user_friends
          WHERE id = $1
            AND status = 'accepted'
            AND (
              requester_id = $2
              OR receiver_id = $2
            )
          `,
          [
            friendshipId,
            myUserId
          ]
        );


      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到這位好友，或你沒有權限刪除"
        });
      }


      // 永久刪除好友關係
      await pg.query(
        `
        DELETE FROM user_friends
        WHERE id = $1
        `,
        [friendshipId]
      );


      return res.json({
        ok: true,
        message: "已刪除好友"
      });

    } catch (error) {

      console.error(
        "刪除好友失敗:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "刪除好友失敗"
      });
    }
  }
);


// ============================================================
// 6. 取得好友動態牆
// 顯示自己的貼文 + 已接受好友的貼文
// ============================================================
app.get(
  "/api/friends/posts/feed",
  authMiddleware,
  async (req, res) => {

    try {
      const myUserId = req.user.userId;

      const result = await pg.query(
        `
        SELECT
          p.id AS post_id,
          p.content,
          p.created_at,
          p.restaurant_id,

          (p.user_id = $1) AS is_owner,

          r.name AS restaurant_name,

          u.id AS user_id,
          u.nickname,
          u.username AS student_id,

          COALESCE(
  (
    SELECT json_agg(
      pi.image_url
      ORDER BY pi.sort_order ASC, pi.id ASC
    )
    FROM post_images pi
    WHERE pi.post_id = p.id
  ),
  '[]'::json
) AS images,
 (
  SELECT COUNT(*)::int
  FROM post_likes pl
  WHERE pl.post_id = p.id
) AS like_count,

EXISTS (
  SELECT 1
  FROM post_likes pl2
  WHERE pl2.post_id = p.id
    AND pl2.user_id = $1
) AS liked_by_me,

(
  SELECT COUNT(*)::int
  FROM post_comments pc
  WHERE pc.post_id = p.id
) AS comment_count

        FROM posts p

        JOIN users u
          ON u.id = p.user_id

        LEFT JOIN restaurants r
          ON r.id = p.restaurant_id

        WHERE
          p.user_id = $1

          OR

          p.user_id IN (
            SELECT
              CASE
                WHEN uf.requester_id = $1
                  THEN uf.receiver_id
                ELSE uf.requester_id
              END
            FROM user_friends uf
            WHERE
              (
                uf.requester_id = $1
                OR
                uf.receiver_id = $1
              )
              AND uf.status = 'accepted'
          )

        ORDER BY
          p.created_at DESC,
          p.id DESC

        LIMIT 50
        `,
        [myUserId]
      );

      return res.json({
        ok: true,
        posts: result.rows
      });

    } catch (error) {

      console.error(
        "取得好友動態牆失敗:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message || "取得好友動態失敗"
      });
    }
  }
);


// ============================================================
// 7. 取得特定好友的個人貼文
// ============================================================
app.get(
  "/api/friends/posts/user/:targetUserId",
  authMiddleware,
  async (req, res) => {

    try {
      const myUserId = req.user.userId;

      const targetUserId =
        Number(req.params.targetUserId);

      if (!Number.isInteger(targetUserId)) {
        return res.status(400).json({
          ok: false,
          error: "使用者 ID 格式錯誤"
        });
      }

      // 如果不是自己，就檢查是否為好友
      if (targetUserId !== myUserId) {

        const friendshipCheck =
          await pg.query(
            `
            SELECT id
            FROM user_friends
            WHERE
              (
                (
                  requester_id = $1
                  AND receiver_id = $2
                )

                OR

                (
                  requester_id = $2
                  AND receiver_id = $1
                )
              )

              AND status = 'accepted'

            LIMIT 1
            `,
            [
              myUserId,
              targetUserId
            ]
          );

        if (
          friendshipCheck.rows.length === 0
        ) {
          return res.status(403).json({
            ok: false,
            error: "只能查看好友的動態"
          });
        }
      }

      const result = await pg.query(
        `
        SELECT
          p.id AS post_id,
          p.content,
          p.created_at,
          p.restaurant_id,

          r.name AS restaurant_name,

          u.id AS user_id,
          u.nickname,
          u.username AS student_id,

          COALESCE(
  (
    SELECT json_agg(
      pi.image_url
      ORDER BY pi.sort_order ASC, pi.id ASC
    )
    FROM post_images pi
    WHERE pi.post_id = p.id
  ),
  '[]'::json
) AS images

        FROM posts p

        JOIN users u
          ON u.id = p.user_id

        LEFT JOIN restaurants r
          ON r.id = p.restaurant_id

        WHERE p.user_id = $1

        ORDER BY
          p.created_at DESC,
          p.id DESC
        `,
        [targetUserId]
      );

      return res.json({
        ok: true,
        posts: result.rows
      });

    } catch (error) {

      console.error(
        "取得指定好友動態失敗:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "取得指定好友動態失敗"
      });
    }
  }
);
// ============================================================
// 📝 發布貼文
// 文字 + Tag 餐廳
// ============================================================
// ============================================================
// 📝 發布貼文
// 文字 + Tag 餐廳 + 圖片
// ============================================================
app.post(
  "/api/posts",
  authMiddleware,
  upload.array("images", 5),
  async (req, res) => {
    try {
      const userId = req.user.userId;

      const content =
        typeof req.body.content === "string"
          ? req.body.content.trim()
          : "";

      const restaurantId =
        req.body.restaurantId
          ? Number(req.body.restaurantId)
          : null;

      if (!content) {
        return res.status(400).json({
          ok: false,
          error: "請輸入貼文內容"
        });
      }

      if (content.length > 500) {
        return res.status(400).json({
          ok: false,
          error: "貼文最多 500 個字"
        });
      }

      if (restaurantId !== null) {
        if (!Number.isInteger(restaurantId)) {
          return res.status(400).json({
            ok: false,
            error: "餐廳 ID 格式錯誤"
          });
        }

        const restaurantCheck = await pg.query(
          `
          SELECT id
          FROM restaurants
          WHERE id = $1
          `,
          [restaurantId]
        );

        if (restaurantCheck.rows.length === 0) {
          return res.status(404).json({
            ok: false,
            error: "找不到這間餐廳"
          });
        }
      }

      // 先建立貼文
      const result = await pg.query(
        `
        INSERT INTO posts
        (
          user_id,
          restaurant_id,
          content
        )
        VALUES ($1, $2, $3)

        RETURNING
          id,
          user_id,
          restaurant_id,
          content,
          created_at
        `,
        [
          userId,
          restaurantId,
          content
        ]
      );

      const post = result.rows[0];

// ============================================================
// 🖼️ 上傳多張貼文圖片
// ============================================================

const imageUrls = [];

if (req.files && req.files.length > 0) {

  console.log(
    `📷 收到 ${req.files.length} 張貼文照片`
  );

  for (let i = 0; i < req.files.length; i++) {

    const file = req.files[i];

    const uploadResult =
      await new Promise((resolve, reject) => {

        const stream =
          cloudinary.uploader.upload_stream(
            {
              folder: "food_posts",
              resource_type: "image"
            },
            (error, result) => {

              if (error) {
                reject(error);
              } else {
                resolve(result);
              }

            }
          );

        stream.end(file.buffer);
      });


    const imageUrl =
      uploadResult.secure_url;


    // 存進 post_images
    await pg.query(
      `
      INSERT INTO post_images
      (
        post_id,
        image_url,
        sort_order
      )
      VALUES ($1, $2, $3)
      `,
      [
        post.id,
        imageUrl,
        i
      ]
    );


    imageUrls.push(imageUrl);

    console.log(
      `✅ 第 ${i + 1} 張圖片上傳成功`
    );
  }
}

      return res.status(201).json({
  ok: true,
  message: "貼文發布成功！",
  post: {
    ...post,
    images: imageUrls
  }
});

    } catch (error) {
      console.error(
        "發布貼文失敗:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "發布貼文失敗"
      });
    }
  }
);

// ============================================================
// 🗑️ 永久刪除自己的貼文
// ============================================================
app.delete(
  "/api/posts/:postId",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const postId = Number(req.params.postId);

      // 檢查貼文 ID
      if (!Number.isInteger(postId)) {
        return res.status(400).json({
          ok: false,
          error: "貼文 ID 格式錯誤"
        });
      }

      // 先確認這篇貼文存在，而且是自己的
      const postCheck = await pg.query(
        `
        SELECT id
        FROM posts
        WHERE id = $1
          AND user_id = $2
        `,
        [postId, userId]
      );



      if (postCheck.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到貼文，或你沒有刪除權限"
        });
      }

      // 先刪按讚紀錄
      await pg.query(
        `
        DELETE FROM post_likes
        WHERE post_id = $1
        `,
        [postId]
      );

      // 再刪圖片紀錄
      await pg.query(
        `
        DELETE FROM post_images
        WHERE post_id = $1
        `,
        [postId]
      );

      // 最後刪除貼文
      await pg.query(
        `
        DELETE FROM posts
        WHERE id = $1
          AND user_id = $2
        `,
        [postId, userId]
      );

      return res.json({
        ok: true,
        message: "貼文已永久刪除"
      });

    } catch (error) {
      console.error(
        "刪除貼文失敗:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "刪除貼文失敗"
      });
    }
  }
);

// ============================================================
// ❤️ 貼文按讚 / 取消按讚
// ============================================================

app.post(
  "/api/posts/:postId/like",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const postId = Number(req.params.postId);

      if (!Number.isInteger(postId)) {
        return res.status(400).json({
          ok: false,
          error: "貼文 ID 格式錯誤"
        });
      }

      // 確認貼文存在
      const postCheck = await pg.query(
        `
        SELECT id
        FROM posts
        WHERE id = $1
        `,
        [postId]
      );

      if (postCheck.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到這篇貼文"
        });
      }

      // 看自己有沒有按過讚
      const existingLike = await pg.query(
        `
        SELECT id
        FROM post_likes
        WHERE post_id = $1
          AND user_id = $2
        `,
        [postId, userId]
      );

      let liked = false;

      if (existingLike.rows.length > 0) {
        // 已經按過 → 取消讚
        await pg.query(
          `
          DELETE FROM post_likes
          WHERE post_id = $1
            AND user_id = $2
          `,
          [postId, userId]
        );

        liked = false;

      } else {
        // 還沒按 → 新增讚
        await pg.query(
          `
          INSERT INTO post_likes
          (
            post_id,
            user_id
          )
          VALUES ($1, $2)
          ON CONFLICT (post_id, user_id)
          DO NOTHING
          `,
          [postId, userId]
        );

        liked = true;
      }

      // 回傳最新讚數
      const countResult = await pg.query(
        `
        SELECT COUNT(*)::int AS like_count
        FROM post_likes
        WHERE post_id = $1
        `,
        [postId]
      );

      return res.json({
        ok: true,
        liked,
        like_count: countResult.rows[0].like_count
      });

    } catch (error) {
      console.error("切換貼文按讚失敗:", error);

      return res.status(500).json({
        ok: false,
        error: "按讚失敗"
      });
    }
  }
);


// ============================================================
// 💬 取得某篇貼文的留言
// ============================================================

app.get(
  "/api/posts/:postId/comments",
  authMiddleware,
  async (req, res) => {
    try {
      const postId = Number(req.params.postId);

      if (!Number.isInteger(postId)) {
        return res.status(400).json({
          ok: false,
          error: "貼文 ID 格式錯誤"
        });
      }

      const result = await pg.query(
        `
        SELECT
          pc.id,
          pc.content,
          pc.created_at,
          u.id AS user_id,
          u.nickname,
          u.username AS student_id
        FROM post_comments pc

        JOIN users u
          ON u.id = pc.user_id

        WHERE pc.post_id = $1

        ORDER BY
          pc.created_at ASC,
          pc.id ASC
        `,
        [postId]
      );

      return res.json({
        ok: true,
        comments: result.rows
      });

    } catch (error) {
      console.error("取得貼文留言失敗:", error);

      return res.status(500).json({
        ok: false,
        error: "取得留言失敗"
      });
    }
  }
);


// ============================================================
// 💬 新增貼文留言
// ============================================================

app.post(
  "/api/posts/:postId/comments",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const postId = Number(req.params.postId);

      const content =
        typeof req.body.content === "string"
          ? req.body.content.trim()
          : "";

      if (!Number.isInteger(postId)) {
        return res.status(400).json({
          ok: false,
          error: "貼文 ID 格式錯誤"
        });
      }

      if (!content) {
        return res.status(400).json({
          ok: false,
          error: "請輸入留言"
        });
      }

      if (content.length > 300) {
        return res.status(400).json({
          ok: false,
          error: "留言最多 300 個字"
        });
      }

      // 確認貼文存在
      const postCheck = await pg.query(
        `
        SELECT id
        FROM posts
        WHERE id = $1
        `,
        [postId]
      );

      if (postCheck.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "找不到這篇貼文"
        });
      }

      const result = await pg.query(
        `
        INSERT INTO post_comments
        (
          post_id,
          user_id,
          content
        )
        VALUES ($1, $2, $3)

        RETURNING
          id,
          post_id,
          user_id,
          content,
          created_at
        `,
        [
          postId,
          userId,
          content
        ]
      );

      const comment = result.rows[0];

      // 抓留言者暱稱
      const userResult = await pg.query(
        `
        SELECT
          nickname,
          username
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      const user = userResult.rows[0];

      return res.status(201).json({
        ok: true,
        comment: {
          ...comment,
          nickname:
            user?.nickname ||
            user?.username ||
            "使用者"
        }
      });

    } catch (error) {
      console.error("新增貼文留言失敗:", error);

      return res.status(500).json({
        ok: false,
        error: "留言失敗"
      });
    }
  }
);

// ============================================================
// 🔎 搜尋可以 Tag 的餐廳
// ============================================================
app.get("/api/posts/restaurants/search", authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.json({
        ok: true,
        restaurants: []
      });
    }

    const result = await pg.query(
      `
      SELECT
        id,
        name,
        address
      FROM restaurants
      WHERE name ILIKE $1
      ORDER BY
        rating DESC NULLS LAST,
        name ASC
      LIMIT 10
      `,
      [`%${q}%`]
    );

    return res.json({
      ok: true,
      restaurants: result.rows
    });

  } catch (error) {
    console.error("搜尋 Tag 餐廳失敗:", error);

    return res.status(500).json({
      ok: false,
      error: "搜尋餐廳失敗"
    });
  }
});
 
// ============================================================
// 📷 Multer 圖片上傳錯誤處理
// ============================================================
app.use((err, req, res, next) => {

  if (err instanceof multer.MulterError) {
    console.error("❌ Multer 上傳錯誤:", err);

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        ok: false,
        error: "每張照片不能超過 5MB"
      });
    }

    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        ok: false,
        error: "圖片欄位名稱錯誤，請重新整理後再試"
      });
    }

    return res.status(400).json({
      ok: false,
      error: `圖片上傳失敗：${err.message}`
    });
  }

  if (err) {
    console.error("❌ Server error:", err);

    return res.status(500).json({
      ok: false,
      error: err.message || "伺服器錯誤"
    });
  }

  next();
});

start();