require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Client } = require("pg");
 
const app = express();
 
app.use(cors());
app.use(express.json());

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in environment");
  process.exit(1);
}
 
if (!GOOGLE_MAPS_API_KEY) {
  console.error("Missing GOOGLE_MAPS_API_KEY in environment");
  process.exit(1);
}
 
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment");
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

// =====================
// ✅ GPT 餐廳推薦（OpenAI）
// =====================
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/api/gpt/recommend", async (req, res) => {
  console.log("===== GPT API DEBUG START =====");

  const now = Date.now();

  if (now - lastRequestTime < 1500) {
    return res.status(429).json({
      error: "請慢一點"
    });
  }

  lastRequestTime = now;

  try {
    const { message } = req.body;

    console.log("📩 使用者輸入:", message);

    // 🔍 檢查 API KEY
    if (!process.env.OPENAI_API_KEY) {
      console.error("❌ OPENAI_API_KEY 沒設定");
      return res.status(500).json({
        error: "OPENAI_API_KEY 未設定"
      });
    }

    // 1️⃣ 抓資料庫
    const result = await pg.query(`
      SELECT id, name, rating, price_level, opening_now
      FROM restaurants
      LIMIT 20
    `);

    const restaurants = result.rows;

    console.log("🍜 餐廳數量:", restaurants.length);

    if (restaurants.length === 0) {
      console.warn("⚠️ 沒抓到餐廳資料");
    }

    // 2️⃣ 呼叫 GPT
    console.log("🤖 準備呼叫 GPT...");

    const response = await openai.responses.create({
      model: "gpt-4.1-mini", // ✅ 穩定版本
      input: `
      你是餐廳推薦系統。

      規則：
      1. 只能從資料選
      2. 不可以亂編
      3. 用繁體中文

      使用者需求：
      ${message}

      餐廳資料：
      ${JSON.stringify(restaurants)}

      請推薦3間餐廳：
`
    });

    console.log("✅ GPT 回傳成功");

    // 🔍 抓回傳內容（保險寫法）
    const reply =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text;

    console.log("🧠 GPT 回答:", reply);

    if (!reply) {
      console.error("❌ GPT 沒有回內容");
      return res.status(500).json({
        error: "GPT 沒有回應",
        raw: response
      });
    }

    console.log("===== GPT API DEBUG END =====");

    res.json({ reply });

  } catch (err) {
    console.error("💥 GPT 錯誤:");

    // 🔍 詳細錯誤解析
    console.error("status:", err.response?.status);
    console.error("data:", err.response?.data);
    console.error("message:", err.message);

    res.status(500).json({
      error: "GPT推薦失敗",
      detail: err.response?.data || err.message
    });
  }
});
 
// =====================
// ✅ AI 聊天 Proxy（Gemini）
// =====================
const SYSTEM_PROMPT = `你是「食在中原」App 的 AI 美食助手，專門推薦台灣桃園中壢中原大學附近的餐廳美食。
用繁體中文回覆，語氣親切像朋友聊天，不要用條列式，回答簡短（50字內）。
如果用戶問餐廳以外的事，就說你只負責美食推薦。`;
 
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "INVALID_MESSAGES" });
    }

    // ⚠️ Gemini 規範：角色必須是 user 或 model，且通常建議第一則訊息必須是 user
    const geminiContents = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content).slice(0, 2000) }],
      }));


    // 💡 就在這裡加！
    console.log("--- 準備發送給 Gemini 的內容 ---");
    console.log(JSON.stringify(geminiContents, null, 2));
    console.log("-------------------------------");

    // 1. 這裡是你剛才印出 Debug 的地方，這段沒問題
    const MODEL_NAME = "gemini-2.0-flash-lite";
    const finalUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    // console.log("--- 正在執行 ---");

    // 2. 🚨 關鍵修正：請確保 axios.post 的第一個參數「只有」finalUrl
    const response = await callGeminiWithRetry(
      finalUrl,
      {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: geminiContents,
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 0.7,
        },
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      }
    );

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      return res.status(500).json({ error: "AI 無法生成回應" });
    }

    return res.json({ reply });

  } catch (err) {
    // --- 錯誤攔截邏輯 ---
    const status = err.response?.status;
    const errorDetail = err.response?.data;

    if (status === 429) {
      console.error("觸發 Gemini 流量限制 (429)");
      return res.status(429).json({ error: "發送太快啦！請稍等 1 分鐘再試。" });
    }

    // 印出詳細錯誤供 Debug
    console.error("POST /api/chat 錯誤詳情:", status, errorDetail || err.message);

    res.status(status || 502).json({ 
      error: "AI 服務暫時無法連線", 
      message: err.message 
    });
  }
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
 
/**
 * GET /api/restaurants
 */
app.get("/api/restaurants", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const open = req.query.open === "true";
    const parsedLimit = parseInt(req.query.limit || "30", 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 30;
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
        (
          SELECT p.photo_reference
          FROM restaurant_photos p
          WHERE p.restaurant_id = r.id
          ORDER BY p.id ASC
          LIMIT 1
        ) AS photo_reference
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
 
/**
 * 取得單一餐廳（含多張照片）
 */
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
      SELECT photo_reference, width, height
      FROM restaurant_photos
      WHERE restaurant_id = $1
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
  });
}

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key";

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({ ok: false, error: "請輸入帳號和密碼" });
    }

    if (password.length < 4) {
      return res.json({ ok: false, error: "密碼至少需要 4 個字" });
    }

    const exists = await pg.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (exists.rows.length > 0) {
      return res.json({ ok: false, error: "這個帳號已經被註冊" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pg.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
      [username, passwordHash]
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
    });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ ok: false, error: "登入失敗" });
  }
});
 
start();