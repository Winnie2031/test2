/** 食在中原 API：放在 backend/server.js；沿用既有資料表與前端路由。 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

const app = express();
const { DATABASE_URL, GOOGLE_MAPS_API_KEY } = process.env;
if (!DATABASE_URL || !GOOGLE_MAPS_API_KEY) {
  console.error('Missing DATABASE_URL or GOOGLE_MAPS_API_KEY');
  process.exit(1);
}
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key';
const pg = new Pool({ connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false });
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const FRONTEND_DIR = path.join(__dirname, '..');
// 前端位於專案根目錄；禁止透過靜態路由下載 backend 的程式與設定。
app.use('/backend', (req, res) => res.sendStatus(404));
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 共用驗證與錯誤處理
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function idOf(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, '編號格式錯誤');
  return id;
}
function optionalUser(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try { return jwt.verify(header.slice(7), JWT_SECRET); } catch { return null; }
}
function authMiddleware(req, res, next) {
  req.user = optionalUser(req);
  if (!req.user?.userId) return res.status(401).json({ ok: false, error: '尚未登入或登入已過期，請重新登入' });
  next();
}
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
function textOf(value, min, max, label) {
  if (typeof value !== 'string') fail(400, `${label}格式錯誤`);
  const text = value.trim();
  if (text.length < min || text.length > max) fail(400, `${label}長度必須為 ${min}～${max} 個字`);
  return text;
}
function passwordCheck(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{4,10}$/.test(value)) fail(400, '密碼必須為 4～10 個英數字');
}
async function restaurantExists(id) {
  if (!(await pg.query('SELECT id FROM restaurants WHERE id=$1', [id])).rowCount) fail(404, '找不到這間餐廳');
}
async function transaction(work) {
  const db = await pg.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

// 餐廳與照片
app.get('/api/photo/:ref', route(async (req, res) => {
  const width = parseInt(req.query.maxwidth || '800', 10);
  const response = await axios.get('https://maps.googleapis.com/maps/api/place/photo', {
    params: { maxwidth: Number.isFinite(width) ? Math.min(Math.max(width, 100), 1600) : 800,
      photo_reference: req.params.ref, key: GOOGLE_MAPS_API_KEY },
    responseType: 'stream', timeout: 15000, maxRedirects: 5 });
  if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  response.data.on('error', error => { console.error('Photo stream failed:', error.message); res.destroy(); });
  response.data.pipe(res);
}));
app.get('/api/restaurants', route(async (req, res) => {
  const where = [], params = [];
  const q = String(req.query.q || '').trim(), tag = String(req.query.tag || '').trim();
  if (q) { params.push(`%${q}%`); where.push(`r.name ILIKE $${params.length}`); }
  if (req.query.open === 'true') where.push('r.opening_now=true');
  if (tag) { params.push(tag); where.push(`$${params.length}=ANY(r.tags)`); }
  const parsed = parseInt(req.query.limit || '500', 10);
  params.push(Number.isFinite(parsed) ? Math.max(parsed, 1) : 500);
  const order = req.query.sort === 'reviews' ? 'r.user_ratings_total DESC NULLS LAST'
    : req.query.sort === 'price' ? 'r.price_level ASC NULLS LAST' : 'r.rating DESC NULLS LAST';
  const result = await pg.query(`SELECT r.id,r.google_place_id,r.name,r.address,r.lat,r.lng,r.rating,
    r.user_ratings_total,r.price_level,r.opening_now,r.opening_hours_json,r.business_status,
    r.phone,r.website,r.google_maps_url,r.delivery,r.dine_in,r.takeout,r.reservable,
    r.wheelchair_accessible_entrance,r.details_fetched_at,r.tags,
    (SELECT p.image_url FROM restaurant_photos p WHERE p.restaurant_id=r.id
      AND p.image_url IS NOT NULL ORDER BY p.id ASC LIMIT 1) AS image_url
    FROM restaurants r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order} LIMIT $${params.length}`, params);
  res.json({ ok: true, data: result.rows });
}));
app.get('/api/restaurants/:id', route(async (req, res) => {
  const id = idOf(req.params.id);
  const result = await pg.query('SELECT * FROM restaurants WHERE id=$1', [id]);
  if (!result.rowCount) fail(404, 'NOT_FOUND');
  const photos = await pg.query(`SELECT image_url FROM restaurant_photos WHERE restaurant_id=$1
    AND image_url IS NOT NULL ORDER BY id ASC LIMIT 10`, [id]);
  res.json({ ok: true, data: { ...result.rows[0], photos: photos.rows } });
}));
app.get('/api/restaurants/:id/google-review-photos', route(async (req, res) => {
  const id = idOf(req.params.id);
  const result = await pg.query('SELECT rating,user_ratings_total,google_place_id FROM restaurants WHERE id=$1', [id]);
  if (!result.rowCount) fail(404, '找不到餐廳');
  const reviews = await pg.query(`SELECT google_review_id,author_name,rating,content,published_text,
    published_at,review_rank,MAX(fetched_at) AS fetched_at,
    ARRAY_AGG(cloudinary_url ORDER BY photo_index) AS photos
    FROM google_review_photo_imports WHERE restaurant_id=$1 AND review_rank IS NOT NULL
    GROUP BY google_review_id,author_name,rating,content,published_text,published_at,review_rank
    ORDER BY review_rank ASC LIMIT 5`, [id]);
  const restaurant = result.rows[0];
  const placeId = encodeURIComponent(restaurant.google_place_id);
  res.json({ ok: true, reviews: reviews.rows, rating: restaurant.rating,
    totalReviews: restaurant.user_ratings_total || 0,
    google_maps_uri: `https://www.google.com/maps/search/?api=1&query=${placeId}&query_place_id=${placeId}` });
}));
app.get('/api/restaurants/:id/google-reviews', route(async (req, res) => {
  const id = idOf(req.params.id);
  const cacheResult = await pg.query('SELECT * FROM google_reviews_cache WHERE restaurant_id=$1 LIMIT 1', [id]);
  const cache = cacheResult.rows[0];
  if (cache && Date.now() - new Date(cache.fetched_at).getTime() < 7 * 86400000) {
    return res.json({ ok: true, rating: cache.rating === null ? null : Number(cache.rating),
      totalReviews: cache.total_reviews || 0, googleMapsUri: cache.google_maps_uri || null,
      reviews: cache.reviews_json || [], cache: true, fetchedAt: cache.fetched_at });
  }
  const result = await pg.query('SELECT id,name,google_place_id FROM restaurants WHERE id=$1', [id]);
  if (!result.rowCount) fail(404, '找不到這間餐廳');
  const restaurant = result.rows[0];
  if (!restaurant.google_place_id) fail(404, '這間餐廳沒有 Google Place ID');
  const response = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(restaurant.google_place_id)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'displayName,rating,userRatingCount,reviews,googleMapsUri' },
    params: { languageCode: 'zh-TW' }, timeout: 15000 });
  const place = response.data;
  const reviews = Array.isArray(place.reviews) ? place.reviews.map(review => ({
    author_name: review.authorAttribution?.displayName || 'Google 使用者',
    author_uri: review.authorAttribution?.uri || null, author_photo_uri: review.authorAttribution?.photoUri || null,
    rating: review.rating ?? null, text: review.text?.text || review.originalText?.text || '',
    relative_time: review.relativePublishTimeDescription || null, publish_time: review.publishTime || null,
    google_maps_uri: review.googleMapsUri || place.googleMapsUri || null })) : [];
  await pg.query(`INSERT INTO google_reviews_cache
    (restaurant_id,rating,total_reviews,google_maps_uri,reviews_json,fetched_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,NOW()) ON CONFLICT (restaurant_id) DO UPDATE SET
    rating=EXCLUDED.rating,total_reviews=EXCLUDED.total_reviews,google_maps_uri=EXCLUDED.google_maps_uri,
    reviews_json=EXCLUDED.reviews_json,fetched_at=NOW()`,
    [id, place.rating ?? null, place.userRatingCount ?? 0, place.googleMapsUri || null, JSON.stringify(reviews)]);
  res.json({ ok: true, restaurant: { id, name: restaurant.name }, rating: place.rating ?? null,
    totalReviews: place.userRatingCount ?? 0, googleMapsUri: place.googleMapsUri || null,
    reviews, cache: false, fetchedAt: new Date().toISOString() });
}));

// 帳號與個人資料：沿用原有帳號、密碼與手機格式
app.post('/api/auth/register', route(async (req, res) => {
  const { username, nickname, password, phone } = req.body;
  if (!username || !nickname || !password || !phone) fail(400, '請填寫帳號、暱稱、密碼與手機');
  if (!/^[0-9]{8}$/.test(username)) fail(400, '帳號必須為 8 個純數字');
  const cleanNickname = textOf(nickname, 1, 20, '暱稱');
  passwordCheck(password);
  if (!/^09\d{8}$/.test(phone)) fail(400, '手機號碼必須為 09 開頭的 10 位數字');
  if ((await pg.query('SELECT id FROM users WHERE username=$1', [username])).rowCount) fail(409, '這個帳號已經被註冊');
  if ((await pg.query('SELECT id FROM users WHERE phone=$1', [phone])).rowCount) fail(409, '這個手機號碼已經被註冊');
  await pg.query('INSERT INTO users (username,nickname,password_hash,phone) VALUES ($1,$2,$3,$4)',
    [username, cleanNickname, await bcrypt.hash(password, 10), phone]);
  res.json({ ok: true, message: '註冊成功' });
}));
app.post('/api/auth/login', route(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) fail(400, '請輸入帳號和密碼');
  const result = await pg.query('SELECT * FROM users WHERE username=$1', [username]);
  if (!result.rowCount) fail(400, '帳號不存在，請先註冊');
  const user = result.rows[0];
  if (!(await bcrypt.compare(password, user.password_hash))) fail(400, '密碼錯誤');
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, message: '登入成功', token, username: user.username, nickname: user.nickname });
}));
app.post('/api/auth/reset-password', route(async (req, res) => {
  const { username, phone, newPassword } = req.body;
  if (!username || !phone || !newPassword) fail(400, '請填寫所有欄位');
  passwordCheck(newPassword);
  if (!(await pg.query('SELECT id FROM users WHERE username=$1 AND phone=$2', [username, phone])).rowCount)
    fail(400, '帳號與手機號碼不符，或帳號不存在');
  await pg.query('UPDATE users SET password_hash=$1 WHERE username=$2', [await bcrypt.hash(newPassword, 10), username]);
  res.json({ ok: true, message: '密碼重設成功！請使用新密碼登入' });
}));
app.get('/api/users/me', authMiddleware, route(async (req, res) => {
  const result = await pg.query('SELECT id,username,nickname,phone FROM users WHERE id=$1', [req.user.userId]);
  if (!result.rowCount) fail(404, '找不到使用者');
  res.json({ ok: true, user: result.rows[0] });
}));
app.put('/api/users/me', authMiddleware, route(async (req, res) => {
  const id = req.user.userId;
  const result = await pg.query('SELECT nickname,phone FROM users WHERE id=$1', [id]);
  if (!result.rowCount) fail(404, '找不到使用者');
  const current = result.rows[0];
  for (const key of ['nickname', 'phone']) {
    if (req.body[key] !== undefined && typeof req.body[key] !== 'string') fail(400, '個人資料格式錯誤');
  }
  const nickname = req.body.nickname?.trim() || current.nickname;
  const phone = req.body.phone?.trim() || current.phone;
  if (nickname) textOf(nickname, 1, 20, '暱稱');
  if (phone) {
    if (!/^09\d{8}$/.test(phone)) fail(400, '手機號碼必須為 09 開頭的 10 位數字');
    if ((await pg.query('SELECT id FROM users WHERE phone=$1 AND id!=$2', [phone, id])).rowCount)
      fail(409, '這個手機號碼已經被其他帳號使用');
  }
  const updated = await pg.query('UPDATE users SET nickname=$1,phone=$2 WHERE id=$3 RETURNING id,username,nickname,phone', [nickname, phone, id]);
  res.json({ ok: true, message: '個人資料更新成功', user: updated.rows[0] });
}));

// 私人備忘錄、匿名評論與餐廳收藏
app.get('/api/restaurants/:restaurantId/memo', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT id,content,created_at,updated_at FROM restaurant_memos
    WHERE user_id=$1 AND restaurant_id=$2`, [req.user.userId, idOf(req.params.restaurantId)]);
  res.json({ ok: true, memo: result.rows[0] || null, content: result.rows[0]?.content || '' });
}));
app.put('/api/restaurants/:restaurantId/memo', authMiddleware, route(async (req, res) => {
  const id = idOf(req.params.restaurantId);
  if (typeof req.body.content !== 'string') fail(400, '備忘錄內容格式錯誤');
  await restaurantExists(id);
  const result = await pg.query(`INSERT INTO restaurant_memos (user_id,restaurant_id,content) VALUES ($1,$2,$3)
    ON CONFLICT (user_id,restaurant_id) DO UPDATE SET content=EXCLUDED.content,updated_at=CURRENT_TIMESTAMP RETURNING *`,
    [req.user.userId, id, req.body.content.trim()]);
  res.json({ ok: true, message: '備忘錄已儲存', memo: result.rows[0] });
}));
app.get('/api/restaurants/:restaurantId/comments', route(async (req, res) => {
  const id = idOf(req.params.restaurantId), viewerId = optionalUser(req)?.userId || null;
  await restaurantExists(id);
  const result = await pg.query(`WITH visible_comments AS (
    SELECT id,user_id,content,created_at FROM restaurant_comments WHERE restaurant_id=$1 AND user_id=$2
    UNION ALL SELECT id,user_id,content,created_at FROM (
      SELECT id,user_id,content,created_at FROM restaurant_comments
      WHERE restaurant_id=$1 AND user_id IS DISTINCT FROM $2 ORDER BY created_at DESC,id DESC LIMIT 50) others)
    SELECT id,user_id=$2 AS is_own,content,created_at FROM visible_comments
    ORDER BY (user_id=$2) DESC,created_at DESC,id DESC`, [id, viewerId]);
  res.json({ ok: true, comments: result.rows.map(row => ({ ...row, nickname: '匿名使用者' })) });
}));
app.post('/api/restaurants/:restaurantId/comments', authMiddleware, route(async (req, res) => {
  const id = idOf(req.params.restaurantId), userId = req.user.userId;
  const content = textOf(req.body.content, 3, 300, '評論');
  await restaurantExists(id);
  const recent = await pg.query('SELECT created_at FROM restaurant_comments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId]);
  if (recent.rowCount && Date.now() - new Date(recent.rows[0].created_at).getTime() < 60000) fail(429, '發言太頻繁，請等 1 分鐘再試');
  const result = await pg.query(`INSERT INTO restaurant_comments (restaurant_id,user_id,content)
    VALUES ($1,$2,$3) RETURNING id,content,created_at`, [id, userId, content]);
  res.status(201).json({ ok: true, message: '匿名評論發表成功！', comment: { ...result.rows[0], nickname: '匿名使用者' } });
}));
app.delete('/api/restaurants/:restaurantId/comments/:commentId', authMiddleware, route(async (req, res) => {
  const result = await pg.query('DELETE FROM restaurant_comments WHERE id=$1 AND restaurant_id=$2 AND user_id=$3 RETURNING id',
    [idOf(req.params.commentId), idOf(req.params.restaurantId), req.user.userId]);
  if (!result.rowCount) fail(404, '找不到你發表的這則留言');
  res.json({ ok: true, message: '留言已刪除' });
}));
app.get('/api/favorites', authMiddleware, route(async (req, res) => {
  const result = await pg.query('SELECT restaurant_id FROM user_favorites WHERE user_id=$1', [req.user.userId]);
  res.json({ ok: true, data: result.rows.map(row => row.restaurant_id) });
}));
app.post('/api/favorites/:restaurantId', authMiddleware, route(async (req, res) => {
  const id = idOf(req.params.restaurantId); await restaurantExists(id);
  await pg.query('INSERT INTO user_favorites (user_id,restaurant_id) VALUES ($1,$2) ON CONFLICT (user_id,restaurant_id) DO NOTHING', [req.user.userId, id]);
  res.json({ ok: true });
}));
app.delete('/api/favorites/:restaurantId', authMiddleware, route(async (req, res) => {
  await pg.query('DELETE FROM user_favorites WHERE user_id=$1 AND restaurant_id=$2', [req.user.userId, idOf(req.params.restaurantId)]);
  res.json({ ok: true });
}));

// AI 推薦與歷史對話：保留卡片搜尋標記及前端回傳欄位
const SYSTEM_PROMPT = `你是「食在中原」的台灣美食朋友，使用繁體中文，自然地回覆使用者。
請真的理解這一輪提問和同一對話上下文，不要套用固定句型，也不要反覆使用上一輪的開場白。
回答應像朋友提供具體有幫助的建議，語氣輕鬆、不過度賣萌，每次用詞可變化；不必每次都說「幫你找好」或「快看看」。
只能根據資料庫提供的結果描述，不得虛構店家、價錢、菜單、評分與營業情況；「最好吃」是主觀意見，不能當作事實。
只推薦已確認營業中的店家；無符合店家時，回答「目前沒有營業的店家」。
回覆最多 50 個字元，限一段自然文字，不列點、不編號、不列餐廳清單。
當 qualityContext 表示評價搜尋時，依系統提供的星數、評論數與可信度結果解釋推薦，不要用少量評論的五星店冒稱口碑有代表性。
若 qualityContext.fallback 為 true，簡短說明「較少評論可供參考，先以高星等作為備選」；不能虛構評論人數。
主畫面的推薦數量會由系統另外以綠字顯示，回答裡不需要再報數字。`;

// 使用台灣時間判斷目前是否營業；未知營業資訊一律視為未營業。
function isRestaurantOpenNow(store) {
  if (['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'].includes(store.business_status)) return false;
  let data = store.opening_hours_json;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  const periods = Array.isArray(data) ? data : data?.periods;
  // Only fall back to Google's recorded opening_now when the weekly schedule is unavailable.
  // This is a snapshot, not a live verification; a stale snapshot may be wrong.
  if (!Array.isArray(periods) || periods.length === 0) return store.opening_now === true;
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const part = key => clock.find(p => p.type === key)?.value;
  const today = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday'));
  const now = Number(part('hour')) * 60 + Number(part('minute'));
  const mins = v => /^\d{4}$/.test(String(v)) ? +String(v).slice(0,2)*60 + +String(v).slice(2,4) : null;
  const week = 7*1440, current = today*1440+now;
  for (const p of periods) {
    if (!p?.open) continue;
    const day = Number(p.open.day), from = mins(p.open.time);
    if (!Number.isInteger(day) || day < 0 || day > 6 || from === null) continue;
    if (!p.close) {
      if (periods.length === 1 && day === 0 && from === 0) return true;
      if (day === today && now >= from) return true;
      continue;
    }
    const toDay = Number(p.close.day), to = mins(p.close.time);
    if (!Number.isInteger(toDay) || toDay < 0 || toDay > 6 || to === null) continue;
    let first = day*1440+from, last=toDay*1440+to;
    if (last <= first) last += week;
    if (periods.length === 1 && last-first === week) return true;
    if ((current >= first && current < last) || (current+week >= first && current+week < last)) return true;
  }
  return false;
}

// 目前沒有符合條件的營業店家時，僅建議「明天白天」有明確排定營業的店家。
// 這不代表明日一定正常營業（臨時公休等可能未反映），也不把備選當成現在營業。
function hasScheduledOpeningTomorrowDaytime(store) {
  if (['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'].includes(store.business_status)) return false;
  let data = store.opening_hours_json;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return false; } }
  const periods = Array.isArray(data) ? data : data?.periods;
  if (!Array.isArray(periods) || !periods.length) return false;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short'
  }).format(new Date());
  const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (today < 0) return false;
  const tomorrow = (today + 1) % 7;
  return periods.some(period => {
    const opening = period?.open;
    if (!opening || Number(opening.day) !== tomorrow) return false;
    const time = String(opening.time || '');
    if (!/^\d{4}$/.test(time)) return false;
    const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
    // 明日 05:00 至 14:59 開始營業（包含多數早餐、便當及午餐店）
    return minutes >= 5 * 60 && minutes < 15 * 60;
  });
}

function tomorrowAlternativeReply(rows, intent, excludeNames, scoreSort) {
  const tomorrow = rows.filter(store =>
    !excludeNames.has(store.name) && !isRestaurantOpenNow(store) &&
    hasScheduledOpeningTomorrowDaytime(store) &&
    matchesFoodTags(store, intent.tags) &&
    !matchesFoodTagsAny(store, intent.excludedTags || []) &&
    restaurantMatchesBudget(store, intent)
  ).sort(scoreSort);
  if (!tomorrow.length) return null;
  const name = tomorrow[0].name;
  // 字數限制仍由回傳前的統一 50 字元處理，不輸出假的「目前營業中」推薦卡片。
  return `目前沒有符合這次條件的營業中店家，明天白天可考慮「${name}」，請先確認營業時間。`;
}

// AI 先理解使用者要求，再由資料庫對所有營業中的店家執行篩選，避免模型只挑 3 間。
function adjustedRestaurantScore(row) {
  const n = Math.max(0, Number(row.user_ratings_total) || 0);
  const r = Number.isFinite(Number(row.rating)) && row.rating != null ? Number(row.rating) : 4;
  return (n * r + 30 * 4) / (n + 30);
}
// 評價可信度分組：門檻可依測試結果調整。
// 這是推薦排序的參考標準，不代表 20 則以下評論「毫無價值」。
const HIGH_RATING_MIN_STARS = 4.5;
const HIGH_RATING_MIN_REVIEWS = 20;
function verifiedRating(row) {
  const rating = row.rating == null ? NaN : Number(row.rating);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null;
}
function verifiedReviewCount(row) {
  const reviews = row.user_ratings_total == null ? NaN : Number(row.user_ratings_total);
  return Number.isFinite(reviews) && reviews >= 0 ? reviews : null;
}
function isHighRatingRequest(question) {
  // 不把「評論最多」當作「高評價」，也不干擾使用者要求的其他客觀最高項。
  return /(高評價|評價高|評分高|高評分|好評|口碑好|評價不錯|評價好)/.test(question) &&
    !/(評論最多|評論數最多|評價人數最多)/.test(question);
}
function trustedRatingSort(a, b) {
  return adjustedRestaurantScore(b) - adjustedRestaurantScore(a) ||
    (verifiedReviewCount(b) ?? -1) - (verifiedReviewCount(a) ?? -1) ||
    (verifiedRating(b) ?? -1) - (verifiedRating(a) ?? -1);
}
// 先保留「評分高且評論數充足」的所有店家；若一間也沒有，才改用高星等店家備援。
function selectHighRatedRestaurants(rows) {
  const known = rows.filter(row => verifiedRating(row) !== null);
  const trusted = known.filter(row => verifiedRating(row) >= HIGH_RATING_MIN_STARS &&
    (verifiedReviewCount(row) ?? 0) >= HIGH_RATING_MIN_REVIEWS);
  if (trusted.length) return { rows: trusted.sort(trustedRatingSort), fallback: false };
  const highStars = known.filter(row => verifiedRating(row) >= HIGH_RATING_MIN_STARS);
  if (highStars.length) return { rows: highStars.sort((a,b) =>
    verifiedRating(b)-verifiedRating(a) || trustedRatingSort(a,b)), fallback: true };
  // 找不到 4.5 星以上時，退而求其次選目前候選中星數最高者（可並列）。
  const maxRating = Math.max(-1, ...known.map(row => verifiedRating(row)));
  return { rows: known.filter(row => verifiedRating(row) === maxRating)
    .sort(trustedRatingSort), fallback: true };
}
async function generateNaturalRestaurantReply({ question, history, stores, purpose = 'recommend', qualityContext = null }) {
  if (purpose === 'recommend' && !stores.length) return '目前沒有營業的店家';
  const sample = stores.slice(0, 12).map(x => ({
    name: x.name, rating: x.rating, reviews: x.user_ratings_total,
    tags: x.tags, price_level: x.price_level
  }));
  const recentReply = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const result = await client.responses.create({
    model: 'gpt-4.1-mini',
    temperature: 0.85,
    max_output_tokens: 160,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({
        question, purpose, count: stores.length, examples: sample, qualityContext,
        recent_context: history.slice(-8).map(m => ({ role: m.role, content: String(m.content || '').replace(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g, '').slice(0, 250) })),
        previous_reply_to_avoid: recentReply.replace(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g, '').slice(0, 120),
        requirement: '只輸出本次自然回覆，不要回傳 JSON、控制標記或條列；不得把全部店名逐一列出。'
      }) }
    ]
  });
  const reply = (result.output_text || '').replace(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g, '')
    .replace(/^[\s\"「]+|[\s\"」]+$/g, '').trim();
  return Array.from(reply).slice(0, 50).join('') || '這些營業中的店家都可以參考，看看哪間符合今天的心情！';
}

async function interpretRestaurantRequest({ question, history, possibleTags }) {
  const historyText = history.filter(m => ['user', 'assistant'].includes(m.role))
    .map(m => `${m.role}: ${String(m.content || '').replace(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g, '')}`)
    .join('\n');
  const instruction = `你是台灣餐廳搜尋條件解析器。理解本輪問題和前面對話，輸出一個 JSON 物件，禁止任何額外文字。
欄位：tags(字串陣列，從提供的標籤中選取，OR 聯集)、nameKeyword(使用者明確指定的店名片段，否則空字串)、priceLevels(1/2/3/4 數字陣列，未指定則空陣列)、count(明確指定幾間才給正整數，否則 null)、sort('relevance'|'rating'|'reviews'|'cheap'|'expensive')。
不得自行假設只要 3～5 間。若使用者只是說「推薦餐廳」、「現在可以吃什麼」，tags 必須為 []，代表全部營業中的餐廳。
「飲料」包含手搖飲、飲料類；「麵」包括麵食及各式拉麵、牛肉麵、義大利麵；選擇所有語意相關的現有標籤。
不要把「推薦餐廳」的「餐廳」誤判成店名；不要把「最推薦哪間」誤判為全部搜尋。
priceLevels 表示店家整體價位級距，不代表單品售價；不可假裝知道每一道菜的價格。`;
  const response = await client.responses.create({
    model: 'gpt-4.1-mini', temperature: 0.1, max_output_tokens: 500,
    input: [{ role: 'system', content: instruction }, {
      role: 'user', content: JSON.stringify({
        question, history: historyText, possibleTags
      })
    }]
  });
  const raw = (response.output_text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(raw);
  const legal = new Set(possibleTags);
  return {
    tags: Array.isArray(parsed.tags) ? [...new Set(parsed.tags.filter(t => legal.has(t)))] : [],
    nameKeyword: typeof parsed.nameKeyword === 'string' ? parsed.nameKeyword.trim().slice(0, 80) : '',
    priceLevels: Array.isArray(parsed.priceLevels) ? [...new Set(parsed.priceLevels.map(Number).filter(n => [1,2,3,4].includes(n)))] : [],
    count: Number.isInteger(parsed.count) && parsed.count > 0 ? Math.min(parsed.count, 1000) : null,
    sort: ['relevance', 'rating', 'reviews', 'cheap', 'expensive'].includes(parsed.sort) ? parsed.sort : 'relevance'
  };
}

// 單次 AI 意圖判斷：獨立於前端關鍵字，能辨認跨題追問及混合內容。
async function analyzeFoodIntent(question, history, hasPool, availableTags) {
  const cleanHistory = history.filter(m => ['user', 'assistant'].includes(m.role))
    .slice(-12).map(m => ({role:m.role,content:String(m.content||'')
      .replace(/<<<(?:SEARCH|POOL|PICKS|AVOID):[^>]*>>>/g,'').slice(0,250)}));
  const prompt = `你是餐廳助理的路由與條件解析器，僅輸出有效 JSON，不要 Markdown。
輸出欄位：domain('restaurant'或'unrelated')、query(只保留使用者本輪餐飲相關問句)、followup(boolean)、tags(字串陣列)、priceLevels(1-4陣列)、minBudget(number|null)、maxBudget(number|null)、sort('relevance'|'rating'|'reviews'|'cheap'|'expensive'|'best')、single(boolean)、count(正整數|null)、excludedTags(使用者明確拒絕的餐點分類陣列)。
有晚餐/宵夜/吃什麼/飲料/餐廳/店家/前一輪餐廳比較等需求，domain=restaurant。
完全無關的問題（例如只問蒙娜麗莎是誰、數學、政治、笑話）domain=unrelated，絕對不要因有聊天歷史就說它是餐廳問題。
混合問題（例如「你知道蒙娜麗莎嗎？還有我晚餐要吃甚麼？」），忽略無關部分，query只保留「我晚餐要吃甚麼？」。
「哪間便宜」、「評價高一點的有嗎」、「那100左右的有嗎」、「我想吃200以上的」如果前一輪有推薦集合，followup=true；新的一般推薦 followup=false。
保留前一輪餐廳類型/用餐時段於 followup 的查詢範圍；不要根據先前單店結果把範圍縮小。\n「不想吃便當」、「不要火鍋」是排除條件：excludedTags 應包含對應分類；如果使用者只有提出不要某種類型，tags=[]，不可把被拒絕類別當成正向 tags。這類問句是餐廳相關的追問；有母集合時 followup=true。
「100左右」設定 maxBudget=100 或符合「100左右」的近似級距；「200以下」maxBudget=200；「200以上」minBudget=200；沒有價格要求為null。
有「哪間／哪家／最推薦／最高／最低」的單店比較，single=true；要求數間用count；其他情況列出所有合適店家。
只使用以下合法 tags，不要臆造新 tags。價格級距只是近似，不能當作單道菜的真實售價。`;
  const response = await client.responses.create({model:'gpt-4.1-mini',temperature:0,
    max_output_tokens:750,input:[{role:'system',content:prompt},{role:'user',content:JSON.stringify({
      question,hasPool,recentHistory:cleanHistory,availableTags
    })}]});
  const raw = (response.output_text||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
  const x=JSON.parse(raw),legal=new Set(availableTags);
  return {
    domain:x.domain==='unrelated'?'unrelated':'restaurant',
    query:typeof x.query==='string'&&x.query.trim()?x.query.trim():question,
    followup:Boolean(x.followup)&&hasPool,
    tags:Array.isArray(x.tags)?[...new Set(x.tags.filter(t=>legal.has(t)))]:[],
    excludedTags:Array.isArray(x.excludedTags)?[...new Set(x.excludedTags.filter(t=>legal.has(t)))]:[],
    priceLevels:Array.isArray(x.priceLevels)?[...new Set(x.priceLevels.map(Number).filter(n=>[1,2,3,4].includes(n)))]:[],
    minBudget:Number.isFinite(Number(x.minBudget))&&x.minBudget!==null?Number(x.minBudget):null,
    maxBudget:Number.isFinite(Number(x.maxBudget))&&x.maxBudget!==null?Number(x.maxBudget):null,
    sort:['relevance','rating','reviews','cheap','expensive','best'].includes(x.sort)?x.sort:'relevance',
    single:Boolean(x.single),
    count:Number.isInteger(x.count)&&x.count>0?Math.min(x.count,1000):null
  };
}

// 分類比對同時查標籤與餐廳名稱；名稱明確含「便當」也應命中便當查詢。
function matchesFoodTags(store, requestedTags) {
  if (!requestedTags?.length) return true;
  const name = String(store.name || '').replace(/\s+/g, '').toLowerCase();
  const tags = Array.isArray(store.tags) ? store.tags.map(t => String(t).replace(/\s+/g, '').toLowerCase()) : [];
  return requestedTags.some(raw => {
    const tag = String(raw).replace(/\s+/g, '').toLowerCase();
    return tags.includes(tag) || (tag.length >= 2 && name.includes(tag));
  });
}

// 排除條件是硬限制，不能再把「不想吃便當」中的「便當」當作正向分類。
function matchesFoodTagsAny(store, excludedTags) {
  return excludedTags.length > 0 && matchesFoodTags(store, excludedTags);
}
function getExplicitExcludedFoodTags(question, availableTags) {
  const text = String(question || '').replace(/\s+/g, '');
  // 精確比對常見否定用語；即使 AI 將否定句解析錯，也能確實排除該分類。
  const negation = /(?:不想吃|不想喝|不吃|不喝|不要吃|不要喝|不要|不考慮|排除|避開|不喜歡|換掉)/;
  const escapeRe = value => value.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
  return [...new Set([...availableTags, '便當', '火鍋', '麵食', '早餐', '早午餐', '飲料', '小吃', '韓式', '日式', '素食'])].filter(tag => {
    if (typeof tag !== 'string' || tag.length < 2) return false;
    const pattern = new RegExp(negation.source + '[^，。！？!?、]{0,4}?' + escapeRe(tag));
    return pattern.test(text);
  });
}

// 這些價格級距只有範圍資訊，100 元左右只代表第一級「可能」符合，不能斷言單品價格。
function restaurantMatchesBudget(row,intent){
  const level=Number(row.price_level);
  if(intent.priceLevels.length && !intent.priceLevels.includes(level)) return false;
  if(intent.minBudget===null && intent.maxBudget===null) return true;
  const ranges={1:[100,200],2:[200,400],3:[400,600],4:[600,Infinity]};
  const range=ranges[level];
  if(!range) return false;
  // 價格級距與要求有交集才列入可能選擇；不宣稱可精準滿足單餐預算。
  if(intent.minBudget!==null && range[1]<intent.minBudget) return false;
  if(intent.maxBudget!==null && range[0]>intent.maxBudget) return false;
  return true;
}

app.post('/api/gpt', route(async (req, res) => {
  if (!client) fail(503, 'AI 尚未設定，請確認 OPENAI_API_KEY');
  let question = textOf(req.body.question, 1, 5000, '問題');
  const userId = optionalUser(req)?.userId || null;
  
  // 1. 從前端取得歷史對話紀錄 (預設為空陣列)
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  let currentConvId = req.body.conversationId ? idOf(req.body.conversationId) : null;
  if (userId && currentConvId) {
    if (!(await pg.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2', [currentConvId, userId])).rowCount)
      fail(403, '無權限使用這筆對話');
  }
  // 已登入：以資料庫的完整歷史為準，防止頁面刷新後漏掉早期訊息。
  // 未登入：使用前端記憶體中的完整歷史；關閉頁面後無法恢復。
  const fullHistory = userId && currentConvId
    ? (await pg.query('SELECT role,content FROM ai_messages WHERE conversation_id=$1 ORDER BY id ASC', [currentConvId])).rows
    : history;
  // POOL 標記保存在對話中。每次追問均查找最近一次一般推薦，
  // 而不是使用上一輪單店推薦的結果。
  const latestPoolMessage = [...fullHistory].reverse().find(m => m.role === 'assistant' &&
    /<<<POOL:[\d|]*>>>/.test(String(m.content || '')));
  const poolMatch = String(latestPoolMessage?.content || '').match(/<<<POOL:([\d|]*)>>>/);
  const parentPoolIds = poolMatch ? [...new Set(poolMatch[1].split('|').map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0))] : [];
  // 優先讓 AI 判斷是否與餐飲相關，避免前端的關鍵字誤判。
  const tagRows = await pg.query('SELECT DISTINCT unnest(tags) AS tag FROM restaurants WHERE tags IS NOT NULL');
  const availableTags = tagRows.rows.map(r => r.tag).filter(t => typeof t === 'string' && t.length <= 35).slice(0,200);
  const intent = await analyzeFoodIntent(question, fullHistory, parentPoolIds.length > 0, availableTags);
  // 對話中的餐廳細節追問：交給 AI 判斷，不依賴固定餐點關鍵字。
  // 只引用後端過去真正顯示的店名，不能推測任意分店。
  const previousSearch = [...fullHistory].reverse().find(m => m.role === 'assistant' &&
    /<<<SEARCH:[^>]+>>>/.test(String(m.content || '')));
  const previousSearchMatch = String(previousSearch?.content || '').match(/<<<SEARCH:([^>]*)>>>/);
  const previousSearchNames = previousSearchMatch
    ? [...new Set(previousSearchMatch[1].split('|').map(x => x.trim()).filter(Boolean))] : [];
  const lastFocusedNames = Array.isArray(req.body.lastFocusedNames)
    ? req.body.lastFocusedNames.filter(x => typeof x === 'string').slice(0, 10) : [];
  let detailRequest = false;
  let detailTargetHint = '';
  try {
    const classify = await client.responses.create({
      model: 'gpt-4.1-mini', temperature: 0, max_output_tokens: 140,
      input: [
        { role: 'system', content: `判斷這一句是不是追問特定餐廳的資訊（菜單、飲品、招牌、口味、座位、交通、營業、服務、實際價格、評論等）。只回傳 JSON：{"detail":boolean,"target":""}。詢問哪間好、要推薦新餐廳、想吃什麼、比較哪間等屬於搜尋/推薦，detail=false。若使用「這間／那間／它」等代名詞，或延續上一句的單店話題，detail=true。target 只能填本句明確提到的完整店名，或最近一次回覆確實只有一間餐廳時的該店名；不能自行猜店名。若多間餐廳不清楚指哪間，target 留空。` },
        { role: 'user', content: JSON.stringify({question, priorRestaurants:previousSearchNames.slice(0, 12), lastFocusedNames,
          lastTurns:fullHistory.slice(-4).map(m => ({role:m.role,content:String(m.content||'').replace(/<<<[^>]*>>>/g,'').slice(0,180)}))}) }
      ]
    });
    const parsed = JSON.parse((classify.output_text || '').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim());
    detailRequest = parsed.detail === true;
    detailTargetHint = typeof parsed.target === 'string' ? parsed.target.trim() : '';
  } catch(err) {
    console.warn('[AI_DETAIL_CLASSIFY]', err.message);
    detailRequest = /(?:這間|那間|這家|那家|它).*(?:有什麼|有甚麼|賣什麼|好喝|好吃|菜單|推薦喝|推薦吃|價錢|特色|招牌|怎麼樣|環境|座位)/.test(question);
  }
  // 後端自行解析指代，僅在上一輪明確只指向一家時繼承。
  if (detailRequest && !detailTargetHint && previousSearchNames.length === 1) {
    detailTargetHint = previousSearchNames[0];
  }
  // 判斷新類別問句必須先於沿用歷史限制，避免前輪預算殘留。
  // 「牛排」、「牛排呢」、「那牛排呢？」、「想吃牛排」、「有牛排嗎」都視為新的類別搜尋。
  // 「那100元的牛排呢」有明確新預算，不能套用本段的無條件重置。
  const foodCategories = [...new Set([...availableTags,
    '牛排','便當','火鍋','麵食','飲料','早餐','早午餐','拉麵','小吃','咖啡','壽司','韓式','日式'])]
    .filter(t => typeof t === 'string' && t.length >= 2)
    .sort((a,b) => b.length - a.length);
  const normalizedFoodQuery = question.trim()
    .replace(/[\s。！!？?，,～~]/g, '')
    .replace(/^(?:那如果|那麼|我想吃|我要吃|我想喝|請推薦|有沒有|換成|改成|想吃|想喝|推薦|來點|那|有|找)/, '')
    .replace(/(?:呢|呀|啊|嗎|咧|吧|有嗎|可以嗎|如何|怎麼樣|有哪些|有什麼|有甚麼)$/, '');
  const newExactFoodCategory = !/\d+\s*(?:元|塊)|(?:以下|以內|以上|左右|最便宜|最貴|最高|比較|評分|評論|評價)/.test(question) &&
    foodCategories.includes(normalizedFoodQuery);
  const priorAssistant = [...fullHistory].reverse().find(m => m.role === 'assistant');
  const previousAvoid = String(priorAssistant?.content || '').match(/<<<AVOID:([^>]*)>>>/);
  const carriedAvoid = previousAvoid && intent.followup && !newExactFoodCategory
    ? previousAvoid[1].split('|').filter(t => availableTags.includes(t)) : [];
  if (newExactFoodCategory) {
    intent.followup = false;
    intent.tags = [normalizedFoodQuery];
    intent.priceLevels = [];
    intent.minBudget = null;
    intent.maxBudget = null;
    intent.count = null;
    intent.single = false;
    intent.sort = 'relevance';
    intent.query = normalizedFoodQuery;
  }
  // 價格是使用者明示的硬限制，不能由模型默默忽略或擴大。
  // 例如「50元以下的牛排」一定要求最高 50 元，不可推薦 100～200 元的店家。
  const explicitCeiling = question.match(/(\d{1,5})\s*(?:元|塊)?\s*(?:以下|以內|內)/);
  const explicitFloor = question.match(/(\d{1,5})\s*(?:元|塊)?\s*(?:以上|起)/);
  if (!newExactFoodCategory && explicitCeiling) {
    intent.maxBudget = Number(explicitCeiling[1]);
    intent.minBudget = null;
    intent.priceLevels = [];
  } else if (!newExactFoodCategory && explicitFloor) {
    intent.minBudget = Number(explicitFloor[1]);
    intent.maxBudget = null;
    intent.priceLevels = [];
  }
  // 類型名稱在問句中明確出現時，要同時比對店名和標籤；不能因 AI 遺漏標籤而搜全站。
  if (!newExactFoodCategory && /牛排/.test(question) && !intent.excludedTags.includes('牛排')) {
    if (!intent.tags.includes('牛排')) intent.tags.push('牛排');
  }
  const explicitAvoid = getExplicitExcludedFoodTags(question, availableTags);
  intent.excludedTags = newExactFoodCategory ? [] : [...new Set([...carriedAvoid, ...intent.excludedTags, ...explicitAvoid])];
  if (explicitAvoid.length && parentPoolIds.length) intent.followup = true;
  // 若本輪只有排除要求，不能延用 AI 誤判的正向餐點標籤。
  intent.tags = intent.tags.filter(tag => !intent.excludedTags.includes(tag));
  if (explicitAvoid.length && /^(?:我)?(?:現在)?(?:不想吃|不想喝|不吃|不喝|不要吃|不要喝|不要|不考慮|排除|避開|不喜歡)/.test(question.trim()) &&
      !/(?:想吃|想喝|改吃|換吃|推薦)(?![^，。！？!?]*(?:不想吃|不想喝|不要吃|不要喝))/.test(question.replace(/^(?:我)?(?:現在)?(?:不想吃|不想喝|不吃|不喝|不要吃|不要喝|不要|不考慮|排除|避開|不喜歡)[^，。！？!?]*/, ''))) {
    intent.tags = [];
  }
  // 「便宜的便當」沒有給金額：改按價位排序，而非猜測成 100 元以下。
  // 若使用者明確指定「100元內」，則保留硬性預算條件。
  const foodQuery = String(intent.query || question);
  const hasExplicitPrice = /\d+\s*(?:元|塊)|(?:\d+)\s*(?:以內|以下|以上|左右|~|～|-)/.test(foodQuery);
  if (/(便宜|平價|省錢|低價)/.test(foodQuery) && !hasExplicitPrice) {
    intent.minBudget = null;
    intent.maxBudget = null;
    intent.priceLevels = [];
    if (intent.sort === 'relevance') intent.sort = 'cheap';
  }
  // 避免語意模型漏掉「便當」分類，導致不相關的所有店家進入結果。
  if (/便當/.test(foodQuery) && !intent.excludedTags.includes('便當') && !intent.tags.includes('便當')) intent.tags.push('便當');
  console.info('[AI_FILTER_INTENT]', JSON.stringify({query:foodQuery,tags:intent.tags,
    priceLevels:intent.priceLevels,minBudget:intent.minBudget,maxBudget:intent.maxBudget,sort:intent.sort,excludedTags:intent.excludedTags}));
  if (intent.domain === 'unrelated') {
    return res.json({ok:true, reply:'問題與餐廳無關，請重新發問。',
      conversationId:currentConvId, unrelated:true, recommendationIds:null, restaurants:[]});
  }
  // 混合提問只處理餐飲部分；完整原文仍在使用者端展示。
  const originalQuestion = question;
  question = intent.query;
  const context = typeof req.body.contextStores === 'string' ? req.body.contextStores : JSON.stringify(req.body.contextStores || []);

  // 僅使用資料庫可驗證的餐廳資料進行比較，不信任前端自行提供的評分
  const isFollowUp = req.body.isFollowUp === true;
  const allowedNames = Array.isArray(req.body.allowedNames)
    ? [...new Set(req.body.allowedNames.filter(name => typeof name === 'string' && name.length <= 200))].slice(0, 100)
    : [];
  let allowedStores = [];
  if (isFollowUp && allowedNames.length) {
    const found = await pg.query(
      'SELECT name,rating,user_ratings_total,price_level,address,opening_hours_json,business_status,opening_now FROM restaurants WHERE name = ANY($1::text[])',
      [allowedNames]
    );
    allowedStores = allowedNames.map(name => found.rows.find(store => store.name === name)).filter(Boolean);
  }

  const alternativeFollowUp = isFollowUp && req.body.alternativeFollowUp === true;
  const excludeNames = Array.isArray(req.body.excludeNames)
    ? new Set(req.body.excludeNames.filter(name => typeof name === 'string').slice(0, 100))
    : new Set();

  // 無論追問採用程式比較或 AI 回答，都必須剔除使用者已拒絕的店家。
  if (isFollowUp) {
    allowedStores = allowedStores.filter(store => !excludeNames.has(store.name) && isRestaurantOpenNow(store));
  }

  // 候選店家從資料庫重新核對，避免前端時區、資料快取或判斷不同步造成誤報。
  let generalCandidates = [];
  if (!isFollowUp) {
    let frontendCandidates = [];
    try {
      const rows = JSON.parse(context);
      if (Array.isArray(rows)) frontendCandidates = rows.slice(0, 100);
    } catch { /* 格式不符，回傳空候選 */ }
    if (frontendCandidates.length) {
      const names = [...new Set(frontendCandidates.map(r => r.name).filter(Boolean))];
      const verified = await pg.query(`SELECT name,rating,user_ratings_total,price_level,address,tags,
        business_status,opening_hours_json,opening_now FROM restaurants WHERE name=ANY($1::text[])`, [names]);
      const byName = new Map(verified.rows.map(row => [row.name, row]));
      generalCandidates = frontendCandidates.map(candidate => byName.get(candidate.name))
        .filter(store => store && isRestaurantOpenNow(store)).slice(0, 100);
    }
    // 使用者問「現在有什麼」時，重新搜尋全資料庫，不受上輪候選限制。
    // 僅針對沒有指定菜系/店名的廣泛查詢啟用。
    const broadNowQuestion = /(?:現在|目前|這時候).*(?:有什麼|有甚麼|吃什麼|能吃|可以吃|哪些店)|(?:有什麼|有甚麼).*(?:營業|開著)/.test(question);
    if (broadNowQuestion) {
      const all = await pg.query(`SELECT name,rating,user_ratings_total,price_level,address,tags,
        business_status,opening_hours_json,opening_now FROM restaurants
        ORDER BY rating DESC NULLS LAST, user_ratings_total DESC NULLS LAST`);
      generalCandidates = all.rows.filter(isRestaurantOpenNow).slice(0, 100);
    }
  }

  

  // 直接輸入品牌或部分店名時，先查 PostgreSQL；不要求 AI 產生 PICKS。
  const directNameQuery = typeof req.body.directNameQuery === 'string'
    ? req.body.directNameQuery.trim().slice(0, 80) : '';
  const lookupNames = Array.isArray(req.body.restaurantLookupNames)
    ? [...new Set(req.body.restaurantLookupNames.filter(s => typeof s === 'string'))].slice(0, 30) : [];
  const restaurantSelect = `SELECT r.id,r.name,r.address,r.lat,r.lng,r.rating,r.user_ratings_total,
    r.price_level,r.opening_now,r.opening_hours_json,r.business_status,r.phone,
    r.website,r.google_maps_url,r.tags,
    (SELECT p.image_url FROM restaurant_photos p WHERE p.restaurant_id=r.id
      AND p.image_url IS NOT NULL ORDER BY p.id LIMIT 1) AS image_url
    FROM restaurants r`;
  let matchedRestaurants = [];
  if (!isFollowUp && directNameQuery) {
    const matched = await pg.query(
      `${restaurantSelect} WHERE strpos(lower(r.name),lower($1)) > 0
       ORDER BY CASE WHEN lower(trim(r.name))=lower($1) THEN 0 ELSE 1 END,
         r.rating DESC NULLS LAST LIMIT 50`, [directNameQuery]);
    matchedRestaurants = matched.rows;
  } else if (!isFollowUp && lookupNames.length) {
    const matched = await pg.query(
      `${restaurantSelect} WHERE r.name = ANY($1::text[])
       ORDER BY r.rating DESC NULLS LAST LIMIT 30`, [lookupNames]);
    // 防止前端任意傳入非問題提及的餐廳。
    matchedRestaurants = matched.rows.filter(r => {
      const whole = r.name.replace(/\s+/g, '').toLowerCase();
      const prefix = r.name.trim().split(/[\s　（(\-－—]+/)[0].toLowerCase();
      const q = question.replace(/\s+/g, '').toLowerCase();
      return q.includes(whole) || (prefix.length >= 3 && q.includes(prefix)) ||
        (prefix.length >= 3 && q.includes(prefix.slice(0, 3)));
    });
  }
  

  // 已由資料庫核對並匹配指定餐廳；避免引用未定義變數而造成 HTTP 500。
  const namedRestaurantInfo = lookupNames.length > 0 && matchedRestaurants.length > 0;

  const menuFollowUp = (req.body.menuFollowUp === true || detailRequest) &&
    Boolean(detailTargetHint || (typeof req.body.menuRestaurantName === 'string' && req.body.menuRestaurantName.trim()));
  const menuRestaurantName = menuFollowUp ? (detailTargetHint || req.body.menuRestaurantName).trim().slice(0, 200) : '';
  const asksMenuQuestion =
    /(點什麼|吃什麼|必點|招牌|熱門餐點|人氣餐點|推薦餐點|推薦菜色|菜單|餐點推薦|什麼好吃|最多人點|最多人買|銷量|賣最好|實際價格|確切價格|每一道|每道|餐點|菜色|停售|停賣|下架|不吃辣|不辣|辣度|哪家比較適合|適合.*人)/.test(question);
  const byReviews = /(評價人數|評論數|評論人數|最多人|較多人|多少人|人數|點評)/.test(question);
  const byRating = /(評分|評價高|評價最|星等|幾顆星|最高分)/.test(question);
  const byCheapest = /(最便宜|價格最低|最低價)/.test(question);
  const byExpensive = /(最貴|價格最高)/.test(question);
  let replyText;
  let resolvedMenuRestaurantName = null;
  let recommendationIds = null; // null 表示非一般推薦；[] 表示已確認無符合店家
  let poolUpdated = false;

  // 指定店家的餐點問題採用網路搜尋；普通餐廳推薦仍走原本的 PICKS 流程。
  // 注意：沒有店名時不隨意猜測，避免搜尋到其他分店或品牌。
  let menuQuestion = detailRequest || asksMenuQuestion || req.body.menuQuestion === true || menuFollowUp;

  // 前端沒有找到店名時，後端再次從資料庫辨識「墨竹亭有什麼推薦餐點？」等問句。
  // 不依賴前端是否載入全部餐廳，也不讓模型猜測不存在的店家。
  // 餐點追問的店名不必再次出現在文字內，從前端保存的店名向 DB 驗證。
  if (menuFollowUp && matchedRestaurants.length === 0) {
    const remembered = await pg.query(
      `${restaurantSelect} WHERE r.name = $1 LIMIT 1`, [menuRestaurantName]
    );
    matchedRestaurants = remembered.rows;
  }
  if (menuQuestion && matchedRestaurants.length === 0) {
    const found = await pg.query(
      `${restaurantSelect}
       WHERE length(replace(trim(r.name), ' ', '')) >= 3
         AND position(lower(left(replace(trim(r.name), ' ', ''), 3))
                      in lower(replace($1, ' ', ''))) > 0
       ORDER BY length(r.name) ASC, r.rating DESC NULLS LAST
       LIMIT 12`,
      [question]
    );
    matchedRestaurants = found.rows;
  }

  // 指定店家查詢與餐點追問也不得出現休息中或營業未知的店家。
  if (!detailRequest) matchedRestaurants = matchedRestaurants.filter(isRestaurantOpenNow);
  // 「晚餐要吃什麼？」不是指定店家菜單查詢，應走完整餐廳推薦。
  if (!matchedRestaurants.length && !menuFollowUp) menuQuestion = false;

  const menuTargets = matchedRestaurants.length
    ? matchedRestaurants
    : (isFollowUp && allowedStores.length === 1 ? allowedStores : []);
  const distinctMenuTargets = [...new Map(menuTargets.map(store => [store.name, store])).values()];

  function distinctlyNamedTargets(items, query, comparison) {
    if (!comparison) return items.slice(0, 1);
    const selected = [];
    const keys = new Set();
    for (const item of items) {
      const brand = String(item.name).trim().split(/[\s　（(\-－—]+/)[0].toLowerCase();
      if (keys.has(brand)) continue;
      selected.push(item);
      keys.add(brand);
      if (selected.length >= 3) break;
    }
    return selected;
  }

  const rankingIntent = req.body.rankingIntent === true &&
    /(最推薦|最值得|最好吃|評分最高|評價最高|評論最多|人氣最高|最熱門|哪(?:一)?(?:間|家).*?(?:推薦|好吃|最好)|哪.*?(?:評分|評論).*?最)/.test(question);

  // 價格追問：「哪間便宜」只選一間；下一輪仍沿用 POOL，而非此單店。
  // 評分／人氣最高的追問則交給下方 rankingIntent 分支。
  const priceSelectionQuestion = /(?:哪(?:一)?(?:間|家)|哪個|最|比較|更)(?:.*?)(?:便宜|平價|省錢|價格低|價格最低|最貴|比較貴)|(?:便宜|平價|最貴|價格最低).*?(?:哪(?:一)?(?:間|家))/.test(question);
  const selectionIntent = req.body.selectionFollowUp === true || priceSelectionQuestion;
  const selectingFromParent = parentPoolIds.length > 0 &&
    (selectionIntent || rankingIntent || /(?:評分最高|評論最多|人氣最高)/.test(question));
  // 所有一般推薦與母集合追問走同一流程：先母集合，無符合才全資料庫。
  // 有指定店家且詢問菜單時保留原本的網頁查證流程。
  if (!detailRequest && !menuQuestion && !directNameQuery && !namedRestaurantInfo) {
    const result = await pg.query(`SELECT id,name,rating,user_ratings_total,price_level,tags,
      opening_hours_json,business_status,opening_now,address FROM restaurants`);
    const allOpen = result.rows.filter(isRestaurantOpenNow);
    console.info(`[AI_OPEN] database=${result.rows.length}, open=${allOpen.length}, intent=${JSON.stringify({tags:intent.tags,priceLevels:intent.priceLevels,minBudget:intent.minBudget,maxBudget:intent.maxBudget,followup:intent.followup})}`);
    const poolSet = new Set(parentPoolIds);
    const useParent = intent.followup && poolSet.size > 0;
    const filter = rows => rows.filter(store => {
      if(excludeNames.has(store.name))return false;
      if(!matchesFoodTags(store, intent.tags))return false;
      if(matchesFoodTagsAny(store,intent.excludedTags))return false;
      return restaurantMatchesBudget(store,intent);
    });
    let matches=useParent?filter(allOpen.filter(store=>poolSet.has(Number(store.id)))):filter(allOpen);
    const expanded=useParent && matches.length===0;
    if(expanded) matches=filter(allOpen); // 只有母集合完全不符時才擴大搜尋
    // 「評價高」需兼顧星數與評論數，確定有足夠高可信候選時排除少評價五星店。
    const highRatingRequest = isHighRatingRequest(question);
    let qualityContext = null;
    if (highRatingRequest && matches.length) {
      const ranking = selectHighRatedRestaurants(matches);
      matches = ranking.rows;
      qualityContext = {
        minStars: HIGH_RATING_MIN_STARS, minReviews: HIGH_RATING_MIN_REVIEWS,
        fallback: ranking.fallback,
        rule: ranking.fallback ? '無足夠評論且高分的店家，改依星等提供備選' : '高分且評論數充足的店家優先'
      };
    }
    console.info(`[AI_OPEN] parent=${parentPoolIds.length}, matches=${matches.length}, expanded=${expanded}, highRating=${highRatingRequest}, fallback=${qualityContext?.fallback ?? false}`);
    const scoreSort=(a,b)=>adjustedRestaurantScore(b)-adjustedRestaurantScore(a)||
      Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0);
    if(highRatingRequest)matches.sort(qualityContext?.fallback
      ? (a,b)=>verifiedRating(b)-verifiedRating(a)||trustedRatingSort(a,b)
      : trustedRatingSort);
    else if(intent.sort==='cheap')matches.sort((a,b)=>Number(a.price_level||99)-Number(b.price_level||99)||scoreSort(a,b));
    else if(intent.sort==='expensive')matches.sort((a,b)=>Number(b.price_level||0)-Number(a.price_level||0)||scoreSort(a,b));
    else if(intent.sort==='reviews')matches.sort((a,b)=>Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0)||scoreSort(a,b));
    else if(intent.sort==='rating')matches.sort((a,b)=>Number(b.rating||0)-Number(a.rating||0)||scoreSort(a,b));
    else matches.sort(scoreSort);
    // 追問「哪間」挑一間，其餘保持全部符合條件的店家。
    const displayed=matches.slice(0,intent.single?1:(intent.count||matches.length));
    recommendationIds=displayed.map(row=>Number(row.id));
    if(displayed.length===0){
      // 有明確預算但找不到符合店家，不推薦超預算或隔天才營業的店家。
      const strictPriceRequest = explicitCeiling || explicitFloor;
      replyText=(!strictPriceRequest && tomorrowAlternativeReply(result.rows, intent, excludeNames, scoreSort)) ||
        '目前沒有符合這次條件的營業中店家';
    }else{
      const avoidHint=intent.excludedTags.length ? `（必須避免以下類型：${intent.excludedTags.join('、')}，不可推薦這些店家）` : '';
      const wording=(expanded?`${question}（上一批店家沒有符合條件的，已重新搜尋整個資料庫）`:question)+avoidHint;
      replyText=await generateNaturalRestaurantReply({question:wording,history:fullHistory,
        stores:displayed,purpose:intent.single?'ranking':'recommend',qualityContext});
      if(intent.single && !replyText.includes(displayed[0].name)) {
        replyText=`這次推薦「${displayed[0].name}」，符合你剛提出的比較條件。`;
      }
      replyText+=`<<<SEARCH:${displayed.map(r=>r.name).join('|')}>>>`;
    }
    // 持續儲存排除的分類，讓下一輪『還有其他的嗎』仍遵守使用者不吃的類型。
    if(intent.excludedTags.length)replyText+=`<<<AVOID:${intent.excludedTags.join('|')}>>>`;
    // 新一般推薦與擴大搜尋成功都更新母集合；單店比較不改變母集合。
    if(!useParent || (expanded && matches.length>0)){
      poolUpdated = true;
      replyText+=`<<<POOL:${matches.map(r=>Number(r.id)).join('|')}>>>`;
    }
  } else if (priceSelectionQuestion && selectingFromParent) {
    const result = await pg.query(`SELECT id,name,rating,user_ratings_total,price_level,tags,
      opening_hours_json,business_status,opening_now FROM restaurants WHERE id=ANY($1::int[])`, [parentPoolIds]);
    const candidates = result.rows.filter(row => isRestaurantOpenNow(row) &&
      row.price_level != null && [1,2,3,4].includes(Number(row.price_level)) &&
      !excludeNames.has(row.name));
    const wantsExpensive = /(最貴|比較貴|價格最高)/.test(question);
    candidates.sort((a,b) =>
      (wantsExpensive ? Number(b.price_level)-Number(a.price_level) : Number(a.price_level)-Number(b.price_level)) ||
      adjustedRestaurantScore(b)-adjustedRestaurantScore(a) ||
      Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0));
    if (!candidates.length) {
      replyText = '上一批店家缺少可比較的價位資料，無法確認哪間較便宜。';
      recommendationIds = [];
    } else {
      const best = candidates[0];
      recommendationIds = [best.id];
      replyText = await generateNaturalRestaurantReply({
        question, history: fullHistory, stores: [best], purpose: 'ranking'
      });
      // 確保回覆對應實際店家，無論模型怎麼表達都附上來源店名。
      if (!replyText.includes(best.name)) replyText = `這次會選「${best.name}」，在上一批店家中價位較低，可先參考看看！`;
      replyText += `<<<SEARCH:${best.name}>>>`;
    }
  } else if (rankingIntent) {
    // 以前一輪實際顯示的全部餐廳 ID 作為比較範圍，重新向資料庫核對營業狀態。
    // 「最好吃」屬主觀問題，以有評論數校正的評分當參考，避免冒充客觀事實。
    const ids = parentPoolIds.length ? parentPoolIds : [...new Set(
      (Array.isArray(req.body.rankCandidateIds) ? req.body.rankCandidateIds : [])
      .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 5000);
    let ranked = [];
    if (ids.length) {
      const result = await pg.query(`SELECT id,name,rating,user_ratings_total,
        opening_hours_json,business_status,opening_now FROM restaurants WHERE id=ANY($1::int[])`, [ids]);
      ranked = result.rows.filter(isRestaurantOpenNow);
    }
    const byReviews = /(評論最多|人氣最高|最熱門)/.test(question);
    const byRawRating = /(評分最高|評價最高)/.test(question);
    const adjustedScore = row => {
      const count = Math.max(0, Number(row.user_ratings_total) || 0);
      const rating = row.rating == null ? 4 : Number(row.rating);
      return (count * rating + 30 * 4) / (count + 30);
    };
    // 缺少評分時不能稱其「最高分」；未有評論的店家不能稱為最熱門。
    if (byRawRating) ranked = ranked.filter(row => row.rating != null && Number.isFinite(Number(row.rating)));
    if (byReviews) ranked = ranked.filter(row => row.user_ratings_total != null);
    ranked.sort((a,b) => byReviews
      ? Number(b.user_ratings_total)-Number(a.user_ratings_total) || adjustedScore(b)-adjustedScore(a)
      : byRawRating
        ? Number(b.rating)-Number(a.rating) || Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0)
        : adjustedScore(b)-adjustedScore(a) || Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0));
    if (!ranked.length) {
      replyText = ids.length ? '目前沒有可比較且營業中的餐廳。' : '目前沒有營業的店家';
      recommendationIds = [];
    } else {
      const best = ranked[0];
      recommendationIds = [best.id];
      replyText = await generateNaturalRestaurantReply({
        question, history: fullHistory,
        stores: [{ ...best, tags: [], price_level: null }], purpose: 'ranking'
      });
      if (!replyText.includes(best.name)) replyText = `從上一批店家來看，「${best.name}」的評價表現最符合這題！`;
      replyText += `<<<SEARCH:${best.name}>>>`;
    }
  } else if (!detailRequest && ((!isFollowUp && !Array.isArray(req.body.allMatchIds) && generalCandidates.length === 0 && matchedRestaurants.length === 0) ||
      (isFollowUp && allowedStores.length === 0 && matchedRestaurants.length === 0))) {
    replyText = '目前沒有營業的店家';
  } else if (detailRequest && !menuFollowUp && !matchedRestaurants.length) {
    replyText = '你想了解哪一間餐廳呢？請告訴我店名，我可以幫你查菜單或其他細節。';
  } else if (menuQuestion) {
    // 此分支只處理「有實際店名的餐點／菜單問題」，不使用整間店的 price_level 充當菜單價格。
    if (distinctMenuTargets.length === 0) {
      replyText = detailRequest ? '找不到你指的餐廳，請提供完整店名或分店。' : '目前沒有營業的店家';
    } else {
      // 兩家或多家明確提及的餐廳可直接比較；不要一律要求選擇分店。
      // 只提及同品牌、卻對應多個分店時，才請使用者確認。
      const brandKeys = [...new Set(distinctMenuTargets.map(store =>
        String(store.name).trim().split(/[\s　（(\-－—]+/)[0].toLowerCase()
      ))];
      const explicitlyCompared = /(和|與|跟|以及|還有).*(比較|哪家|哪間|適合)|哪家.*比較/.test(question);
      if (distinctMenuTargets.length > 1 && brandKeys.length === 1 && !explicitlyCompared) {
        replyText = `找到多間可能的分店：${distinctMenuTargets.slice(0, 6).map(s => s.name).join('、')}。請指定分店以免菜單混淆。`;
      } else {
        const targets = distinctlyNamedTargets(distinctMenuTargets, question, explicitlyCompared);
        resolvedMenuRestaurantName = targets.length === 1 ? targets[0].name : null;
        const targetDescription = targets.map(t =>
          `店名：${t.name}；地址：${t.address || '未知'}`
        ).join('\n');
        // 細節問答使用模型自身知識，不要求即時搜尋。
        // 對常見品項可提供有保留的實用建議，對不確定的資訊避免虛構。
        const menuPrompt = `你是「食在中原」的台灣在地美食助理。使用者正在追問特定店家的飲品、餐點、菜單、風味或其他細節。
請直接根據你已有的店家、品牌、餐飲常識與使用者喜好給出有幫助的建議；此功能不呼叫網路搜尋，也不要求先取得公開菜單。
優先理解問題：如「這間有什麼好喝的？」應推薦你相對有把握的飲品或風味方向，解釋為何適合；不要反問使用者去查看菜單來代替回答。
如果熟悉該品牌且有把握品項存在，可點名一至三項；如果只知道店型（如手搖飲、咖啡、牛排），就用「可以先考慮茶類／鮮奶茶類」等類型與搭配方向，不要把通用飲品名稱說成這間店實際販售的品項。
不准憑空捏造確定菜名、招牌排行、單品價格、停售、辣度、過敏原、庫存、營業即時狀態或銷售數據；無法確認時用一句簡短自然的保留說明，不必處處重複免責文字。
已提供的資料庫欄位（店名、地址、星等、評論數、類型）可直接使用；價位級距不能當成單品價格。主觀推薦需說明是個人建議，不得冒充真實顧客統計。
回答請使用繁體中文，口吻像熟悉美食的朋友，約 50～160 字，直截了當，避免制式開場，不輸出網址、引用、Markdown 或控制標記。`;
        try {
          const menuResponse = await client.responses.create({
            model: 'gpt-4.1-mini',
            temperature: 0.55,
            input: [
              { role: 'system', content: menuPrompt },
              { role: 'user', content: JSON.stringify({
                restaurants: targets.map(t => ({ name: t.name, address: t.address, tags: t.tags,
                  rating: t.rating, user_ratings_total: t.user_ratings_total, price_level: t.price_level })),
                recentHistory: fullHistory.slice(-8).map(m => ({ role: m.role,
                  content: String(m.content || '').replace(/<<<(?:SEARCH|POOL|PICKS|AVOID):[^>]*>>>/g, '').slice(0, 250) })),
                question
              }) }
            ],
            max_output_tokens: 450
          });
          replyText = (menuResponse.output_text || '').trim().slice(0, 600) ||
            '我目前不太熟悉這間店的具體品項，不過可以依你想要的口味推薦適合的類型。';
        } catch (err) {
          console.error('餐點 AI 回答失敗：', err.message);
          replyText = '目前無法完成這間店的餐點建議，請稍後再試。';
        }
        // 僅更新可確認的餐廳卡片；不以此覆蓋原本的推薦名單。
        if (!detailRequest) replyText += `\n<<<SEARCH:${targets.map(t => t.name).join('|')}>>>`;
      }
    }
  } else if (!isFollowUp && directNameQuery) {
    if (!matchedRestaurants.length) {
      replyText = '目前沒有營業的店家';
    } else {
      replyText = `找到 ${matchedRestaurants.length} 間名稱包含「${directNameQuery}」的餐廳，已在主畫面顯示。` +
        `<<<SEARCH:${matchedRestaurants.map(s => s.name).join('|')}>>>`;
    }
  } else if (!isFollowUp && lookupNames.length && matchedRestaurants.length) {
    const menuQuestion = req.body.menuQuestion === true ||
      /(最多人點|點什麼|熱門餐點|必點|招牌菜|菜單)/.test(question);
    const best = matchedRestaurants[0];
    if (menuQuestion) {
      replyText = `已找到「${best.name}」。目前資料庫沒有實際點餐銷量或熱門餐點排行榜，無法確定最多人點哪一道；可參考店家菜單與顧客評論。`;
    } else if (/(評分|評價|評論)/.test(question)) {
      replyText = `「${best.name}」目前記錄評分 ${best.rating ?? '未知'}，評論 ${best.user_ratings_total ?? '未知'} 則。`;
    } else if (/(價格|價位|便宜|多少錢)/.test(question)) {
      replyText = `「${best.name}」的價格級距為 ${best.price_level ?? '未知'}（不代表實際菜單售價）。`;
    } else if (/(地址|在哪)/.test(question)) {
      replyText = `「${best.name}」地址：${best.address || '資料庫未提供'}。`;
    } else {
      replyText = `已找到「${best.name}」，請參考主畫面的餐廳資料；未收錄的資訊無法確認。`;
    }
    replyText += `<<<SEARCH:${matchedRestaurants.map(s => s.name).join('|')}>>>`;
  } else if (!isFollowUp && Array.isArray(req.body.allMatchIds) &&
             !directNameQuery && !lookupNames.length && !menuQuestion) {
    // AI 解析自然語言條件，但所有店家都由資料庫獨立過濾，不由 AI 限制推薦筆數。
    const result = await pg.query(`SELECT id,name,rating,user_ratings_total,price_level,
      tags,opening_hours_json,business_status,opening_now,address FROM restaurants
      ORDER BY rating DESC NULLS LAST,user_ratings_total DESC NULLS LAST`);
    const openStores = result.rows.filter(isRestaurantOpenNow);
    const tags = [...new Set(openStores.flatMap(store => Array.isArray(store.tags) ? store.tags : []))]
      .filter(tag => typeof tag === 'string' && tag.length <= 35).slice(0, 200);
    const criteria = await interpretRestaurantRequest({question, history: fullHistory, possibleTags: tags});
    let verified = openStores.filter(store => {
      if (criteria.tags.length && !criteria.tags.some(tag => Array.isArray(store.tags) && store.tags.includes(tag))) return false;
      if (criteria.nameKeyword && !String(store.name || '').toLowerCase().includes(criteria.nameKeyword.toLowerCase())) return false;
      if (criteria.priceLevels.length && !criteria.priceLevels.includes(Number(store.price_level))) return false;
      return true;
    });
    if (criteria.sort === 'reviews') verified.sort((a,b) => Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0));
    else if (criteria.sort === 'rating') verified.sort((a,b) => Number(b.rating||0)-Number(a.rating||0) || Number(b.user_ratings_total||0)-Number(a.user_ratings_total||0));
    else if (criteria.sort === 'cheap') verified.sort((a,b) => Number(a.price_level||99)-Number(b.price_level||99));
    else if (criteria.sort === 'expensive') verified.sort((a,b) => Number(b.price_level||0)-Number(a.price_level||0));
    else verified.sort((a,b) => adjustedRestaurantScore(b)-adjustedRestaurantScore(a));
    if (criteria.count !== null) verified = verified.slice(0, criteria.count);
    recommendationIds = verified.map(store => Number(store.id));
    replyText = await generateNaturalRestaurantReply({question, history: fullHistory, stores: verified});
    // 保留全部結果以供後續追問，而不再依賴模型輸出 PICKS 取前幾間。
    if (verified.length) replyText += `<<<SEARCH:${verified.map(store => store.name).join('|')}>>>`;
    replyText += `<<<POOL:${recommendationIds.join('|')}>>>`;
  } else if (!isFollowUp && generalCandidates.length === 0) {
    replyText = '目前沒有營業的店家';
  } else if (alternativeFollowUp) {
    // 從上一輪「完整推薦名單」中選擇替代方案，而非重新搜尋整份資料庫。
    const remaining = allowedStores.filter(store => !excludeNames.has(store.name));
    const wantsCheapAlternative = /(便宜|平價|省錢|低價)/.test(question);
    if (!remaining.length) {
      replyText = '前次推薦的餐廳已沒有其他可選店家，可以請我重新搜尋。';
    } else if (wantsCheapAlternative) {
      const priced = remaining.filter(s => s.price_level != null && Number.isFinite(Number(s.price_level)));
      if (!priced.length) {
        replyText = '其餘餐廳缺少可比較的價格級距，暫時無法判斷哪些比較便宜；可請我重新搜尋平價餐廳。';
      } else {
        priced.sort((a,b) => Number(a.price_level)-Number(b.price_level) || Number(b.rating || 0)-Number(a.rating || 0));
        const lowest = Number(priced[0].price_level);
        const chosen = priced.filter(s => Number(s.price_level) === lowest);
        replyText = `扣除剛才不想吃的店家，原本推薦名單中另有 ${chosen.length} 間價格級距較低的餐廳（第 ${lowest} 級）。請參考主畫面，價格級距不代表實際菜單售價。<<<SEARCH:${chosen.map(s=>s.name).join('|')}>>>`;
      }
    } else {
      replyText = `原本的推薦名單中，扣除剛才那間後還有 ${remaining.length} 間可參考。<<<SEARCH:${remaining.map(s=>s.name).join('|')}>>>`;
    }
  } else if (isFollowUp && (byReviews || byRating || byCheapest || byExpensive)) {
    const metric = byReviews ? 'user_ratings_total' : byRating ? 'rating' : 'price_level';
    const eligible = allowedStores.filter(store => store[metric] != null &&
      Number.isFinite(Number(store[metric])));
    if (!eligible.length) {
      replyText = '先前推薦的餐廳缺少可比較的資料，無法判斷。';
    } else {
      const lowFirst = byCheapest && !byReviews && !byRating;
      eligible.sort((a,b) => lowFirst ? Number(a[metric])-Number(b[metric]) : Number(b[metric])-Number(a[metric]));
      const best = eligible[0];
      const same = eligible.filter(store => Number(store[metric]) === Number(best[metric]));
      const names = same.map(store => store.name).join('、');
      const label = byReviews ? `評論人數最多（${best[metric]} 人）` :
        byRating ? `評分最高（${best[metric]} 分）` :
        lowFirst ? `價格級距最低（第 ${best[metric]} 級）` : `價格級距最高（第 ${best[metric]} 級）`;
      replyText = `${names}${same.length > 1 ? '並列' : ''}${label}。<<<SEARCH:${best.name}>>>`;
    }
  } else if (isFollowUp && allowedStores.length === 0) {
    replyText = '找不到前次推薦的餐廳，請重新推薦一次。';
  } else {
    // 一般推薦用簡短編號代替重複輸出完整店名，能容納較多推薦結果。
    const candidatesText = isFollowUp
      ? JSON.stringify(allowedStores)
      : JSON.stringify(generalCandidates.map((store, index) => ({ index, ...store })));
    const inputMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...fullHistory.filter(msg => msg && ['assistant', 'user'].includes(msg.role) && typeof msg.content === 'string')
        .map(msg => ({ role: msg.role, content: msg.content.replace(/<<<SEARCH:[^>]*>>>/g, '') })),
      { role: 'user', content: `【${isFollowUp ? '只能討論以下餐廳' : '候選餐廳清單'}】：\n${candidatesText}\n【問題】：${question}` }
    ];
    const response = await client.responses.create({
      model: 'gpt-4.1-mini', input: inputMessages, max_output_tokens: 4000
    });
    const rawText = response.output_text?.trim();
    if (!rawText) fail(502, 'AI 未回傳有效內容');

    if (isFollowUp) {
      // 追問保留文字回答，不強制改變原有的單店比較功能。
      const visible = Array.from(rawText.replace(/<<<PICKS:[^>]*>>>/g, '').trim()).slice(0, 50).join('');
      replyText = visible;
    } else {
      const match = rawText.match(/<<<PICKS:([^>]*)>>>/);
      if (!match) {
        // 網路工具以外的非推薦文字若缺少 PICKS，不應以 502 讓使用者看到格式錯誤。
        const fallbackNames = [...new Set(generalCandidates.slice(0, 5).map(r => r.name))];
        replyText = fallbackNames.length
          ? `已找到營業中的餐廳，請查看主畫面。<<<SEARCH:${fallbackNames.join('|')}>>>`
          : '目前沒有營業的店家';
      } else {
      const indices = [...new Set(match[1].split('|').map(s => s.trim())
        .filter(s => /^\d+$/.test(s)).map(Number))]
        .filter(i => Number.isSafeInteger(i) && i >= 0 && i < generalCandidates.length);
      // 無額外 slice(0, 5/10/20)：最多可選出所有 100 間候選的符合店家
      const suggestedNames = [...new Set(indices.map(i => generalCandidates[i].name))];
      const visible = Array.from(rawText.replace(/<<<PICKS:[^>]*>>>/g, '').trim()).slice(0, 50).join('');
      replyText = suggestedNames.length ? visible + `\n<<<SEARCH:${suggestedNames.join('|')}>>>` : '目前沒有符合需求的營業中餐廳';
      }
    }
  }

  // 一般推薦維持簡短；餐廳細節追問保留完整說明，不附帶推薦卡片。
  const internalTags = [...replyText.matchAll(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g)].map(m => m[0]).join('');
  const visibleReply = replyText.replace(/<<<(?:SEARCH|PICKS|POOL|AVOID):[^>]*>>>/g, '').trim();
  replyText = Array.from(visibleReply).slice(0, (detailRequest || menuQuestion) ? 600 : 50).join('') + (internalTags ? '\n' + internalTags : '');

  // 寫入資料庫
  if (userId) currentConvId = await transaction(async db => {
    let convId = currentConvId;
    if (!convId) {
      const result = await db.query('INSERT INTO ai_conversations (user_id,title) VALUES ($1,$2) RETURNING id', [userId, question.substring(0, 30)]);
      convId = result.rows[0].id;
    }
    await db.query(`INSERT INTO ai_messages (conversation_id,role,content) VALUES ($1,'user',$2),($1,'assistant',$3)`, [convId, question, replyText]);
    return convId;
  });
  
  res.json({ ok: true, reply: replyText, conversationId: currentConvId,
    recommendationIds,
    poolUpdated,
    restaurants: matchedRestaurants,
    menuRestaurantName: resolvedMenuRestaurantName, detailAnswer: detailRequest || menuQuestion });
}));


app.get('/api/ai/conversations', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT c.id,c.title,c.created_at,c.is_favorite,
    (SELECT m.content FROM ai_messages m WHERE m.conversation_id=c.id AND m.role='assistant' ORDER BY m.id ASC LIMIT 1) AS ai_reply
    FROM ai_conversations c WHERE c.user_id=$1 ORDER BY c.created_at DESC`, [req.user.userId]);
  res.json({ ok: true, data: result.rows });
}));
app.put('/api/ai/conversations/:id/favorite', authMiddleware, route(async (req, res) => {
  if (typeof req.body.is_favorite !== 'boolean') fail(400, '收藏狀態格式錯誤');
  const result = await pg.query('UPDATE ai_conversations SET is_favorite=$1 WHERE id=$2 AND user_id=$3 RETURNING id',
    [req.body.is_favorite, idOf(req.params.id), req.user.userId]);
  if (!result.rowCount) fail(404, '找不到該筆對話');
  res.json({ ok: true, message: '收藏狀態已更新' });
}));
app.get('/api/ai/conversations/:id', authMiddleware, route(async (req, res) => {
  const id = idOf(req.params.id);
  if (!(await pg.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2', [id, req.user.userId])).rowCount)
    fail(404, '找不到該筆對話');
  const result = await pg.query('SELECT role,content,created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY id ASC', [id]);
  res.json({ ok: true, data: result.rows });
}));
app.delete('/api/ai/conversations/:id', authMiddleware, route(async (req, res) => {
  const id = idOf(req.params.id);
  await transaction(async db => {
    if (!(await db.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, req.user.userId])).rowCount)
      fail(403, '無權限刪除或找不到該筆對話');
    await db.query('DELETE FROM ai_messages WHERE conversation_id=$1', [id]);
    await db.query('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2', [id, req.user.userId]);
  });
  res.json({ ok: true, message: '對話刪除成功' });
}));

// 好友邀請與好友列表
const FRIEND_PAIR = '((requester_id=$1 AND receiver_id=$2) OR (requester_id=$2 AND receiver_id=$1))';
app.get('/api/friends/search', authMiddleware, route(async (req, res) => {
  const studentId = String(req.query.studentId || '').trim(), myId = req.user.userId;
  if (!studentId) fail(400, '請提供學號進行搜尋');
  const result = await pg.query('SELECT id,username AS student_id,nickname FROM users WHERE username=$1 AND id!=$2', [studentId, myId]);
  if (!result.rowCount) fail(404, '找不到該學號的使用者');
  const user = result.rows[0];
  const status = await pg.query(`SELECT id,status FROM user_friends WHERE ${FRIEND_PAIR} ORDER BY id DESC LIMIT 1`, [myId, user.id]);
  res.json({ ok: true, user, friendshipStatus: status.rows[0] ? String(status.rows[0].status).toUpperCase() : 'NONE', friendshipId: status.rows[0]?.id || null });
}));
app.post('/api/friends/request', authMiddleware, route(async (req, res) => {
  const myId = req.user.userId, targetId = idOf(req.body.targetUserId);
  if (Number(myId) === targetId) fail(400, '無法新增自己為好友');
  if (!(await pg.query('SELECT id FROM users WHERE id=$1', [targetId])).rowCount) fail(404, '找不到該使用者');
  const check = await pg.query(`SELECT * FROM user_friends WHERE ${FRIEND_PAIR} ORDER BY id DESC LIMIT 1`, [myId, targetId]);
  const existing = check.rows[0];
  if (existing?.status === 'accepted') fail(400, '你們已經是好友了');
  if (existing?.status === 'pending') fail(400, '已有待處理的好友邀請');
  if (existing?.status === 'rejected') {
    const result = await pg.query(`UPDATE user_friends SET requester_id=$1,receiver_id=$2,status='pending',
      updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *`, [myId, targetId, existing.id]);
    return res.json({ ok: true, message: '好友邀請已重新發送！', friendship: result.rows[0] });
  }
  const result = await pg.query("INSERT INTO user_friends (requester_id,receiver_id,status) VALUES ($1,$2,'pending') RETURNING *", [myId, targetId]);
  res.status(201).json({ ok: true, message: '好友邀請已發送！', friendship: result.rows[0] });
}));
app.post('/api/friends/cancel', authMiddleware, route(async (req, res) => {
  const result = await pg.query("DELETE FROM user_friends WHERE requester_id=$1 AND receiver_id=$2 AND status='pending' RETURNING id", [req.user.userId, idOf(req.body.targetUserId)]);
  if (!result.rowCount) fail(400, '找不到可收回的好友邀請，或對方已同意／拒絕');
  res.json({ ok: true, message: '已成功收回好友邀請！' });
}));
app.get('/api/friends/requests', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT f.id AS friendship_id,f.created_at,u.id AS user_id,u.username AS student_id,u.nickname
    FROM user_friends f JOIN users u ON u.id=f.requester_id WHERE f.receiver_id=$1 AND f.status='pending' ORDER BY f.created_at DESC`, [req.user.userId]);
  res.json({ ok: true, requests: result.rows });
}));
app.put('/api/friends/respond', authMiddleware, route(async (req, res) => {
  const id = idOf(req.body.friendshipId), action = req.body.action;
  if (!['ACCEPT', 'REJECT'].includes(action)) fail(400, '參數不正確');
  const result = await pg.query(`UPDATE user_friends SET status=$1,updated_at=CURRENT_TIMESTAMP
    WHERE id=$2 AND receiver_id=$3 AND status='pending' RETURNING *`, [action === 'ACCEPT' ? 'accepted' : 'rejected', id, req.user.userId]);
  if (!result.rowCount) fail(404, '找不到該好友邀請，或您無權操作');
  res.json({ ok: true, message: action === 'ACCEPT' ? '已同意成為好友！' : '已拒絕好友邀請', friendship: result.rows[0] });
}));
app.get('/api/friends', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT f.id AS friendship_id,u.id AS user_id,u.username AS student_id,u.nickname
    FROM user_friends f JOIN users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.receiver_id ELSE f.requester_id END
    WHERE (f.requester_id=$1 OR f.receiver_id=$1) AND f.status='accepted' ORDER BY u.nickname ASC`, [req.user.userId]);
  res.json({ ok: true, friends: result.rows });
}));
app.delete('/api/friends/:friendshipId', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`DELETE FROM user_friends WHERE id=$1 AND status='accepted'
    AND (requester_id=$2 OR receiver_id=$2) RETURNING id`, [idOf(req.params.friendshipId), req.user.userId]);
  if (!result.rowCount) fail(404, '找不到這位好友，或你沒有權限刪除');
  res.json({ ok: true, message: '已刪除好友' });
}));

// 貼文與互動
const POST_COLUMNS = `p.id AS post_id,p.content,p.created_at,p.restaurant_id,(p.user_id=$1) AS is_owner,
  r.name AS restaurant_name,u.id AS user_id,u.nickname,u.username AS student_id,
  COALESCE((SELECT json_agg(pi.image_url ORDER BY pi.sort_order ASC,pi.id ASC) FROM post_images pi WHERE pi.post_id=p.id),'[]'::json) AS images`;
app.get('/api/friends/posts/feed', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT ${POST_COLUMNS},
    (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
    EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=$1) AS liked_by_me,
    (SELECT COUNT(*)::int FROM post_comments pc WHERE pc.post_id=p.id) AS comment_count
    FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN restaurants r ON r.id=p.restaurant_id
    WHERE p.user_id=$1 OR p.user_id IN (
      SELECT CASE WHEN uf.requester_id=$1 THEN uf.receiver_id ELSE uf.requester_id END FROM user_friends uf
      WHERE (uf.requester_id=$1 OR uf.receiver_id=$1) AND uf.status='accepted')
    ORDER BY p.created_at DESC,p.id DESC LIMIT 50`, [req.user.userId]);
  res.json({ ok: true, posts: result.rows });
}));
app.get('/api/friends/posts/user/:targetUserId', authMiddleware, route(async (req, res) => {
  const targetId = idOf(req.params.targetUserId), myId = req.user.userId;
  if (targetId !== Number(myId) && !(await pg.query(`SELECT id FROM user_friends WHERE ${FRIEND_PAIR} AND status='accepted' LIMIT 1`, [myId, targetId])).rowCount)
    fail(403, '只能查看好友的動態');
  const result = await pg.query(`SELECT ${POST_COLUMNS} FROM posts p JOIN users u ON u.id=p.user_id
    LEFT JOIN restaurants r ON r.id=p.restaurant_id WHERE p.user_id=$2 ORDER BY p.created_at DESC,p.id DESC`, [myId, targetId]);
  res.json({ ok: true, posts: result.rows });
}));
app.post('/api/posts', authMiddleware, upload.array('images', 5), route(async (req, res) => {
  const content = textOf(req.body.content, 1, 500, '貼文');
  const restaurantId = req.body.restaurantId ? idOf(req.body.restaurantId) : null;
  if (restaurantId !== null) await restaurantExists(restaurantId);
  // 先上傳圖片，再以同一資料庫交易寫入貼文與圖片記錄。
  const imageUrls = [];
  for (const file of req.files || []) {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'food_posts', resource_type: 'image' },
        (error, data) => error ? reject(error) : resolve(data));
      stream.end(file.buffer);
    });
    imageUrls.push(result.secure_url);
  }
  const post = await transaction(async db => {
    const result = await db.query(`INSERT INTO posts (user_id,restaurant_id,content) VALUES ($1,$2,$3)
      RETURNING id,user_id,restaurant_id,content,created_at`, [req.user.userId, restaurantId, content]);
    for (let i = 0; i < imageUrls.length; i++) await db.query('INSERT INTO post_images (post_id,image_url,sort_order) VALUES ($1,$2,$3)', [result.rows[0].id, imageUrls[i], i]);
    return result.rows[0];
  });
  res.status(201).json({ ok: true, message: '貼文發布成功！', post: { ...post, images: imageUrls } });
}));
app.delete('/api/posts/:postId', authMiddleware, route(async (req, res) => {
  const postId = idOf(req.params.postId), userId = req.user.userId;
  await transaction(async db => {
    if (!(await db.query('SELECT id FROM posts WHERE id=$1 AND user_id=$2 FOR UPDATE', [postId, userId])).rowCount)
      fail(404, '找不到貼文，或你沒有刪除權限');
    await db.query('DELETE FROM post_comments WHERE post_id=$1', [postId]);
    await db.query('DELETE FROM post_likes WHERE post_id=$1', [postId]);
    await db.query('DELETE FROM post_images WHERE post_id=$1', [postId]);
    await db.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [postId, userId]);
  });
  res.json({ ok: true, message: '貼文已永久刪除' });
}));
app.delete('/api/posts/comments/:commentId', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`DELETE FROM post_comments pc USING posts p WHERE pc.post_id=p.id AND pc.id=$1
    AND (pc.user_id=$2 OR p.user_id=$2) RETURNING pc.post_id`, [idOf(req.params.commentId), req.user.userId]);
  if (!result.rowCount) fail(404, '找不到留言，或你沒有刪除權限');
  res.json({ ok: true, message: '留言已刪除', postId: result.rows[0].post_id });
}));
// 僅保留一個讀取留言路由，包含前端需要的 can_delete。
app.get('/api/posts/:postId/comments', authMiddleware, route(async (req, res) => {
  const result = await pg.query(`SELECT pc.id,pc.content,pc.created_at,pc.user_id,u.nickname,u.username AS student_id,
    (pc.user_id=$2 OR p.user_id=$2) AS can_delete FROM post_comments pc
    JOIN users u ON u.id=pc.user_id JOIN posts p ON p.id=pc.post_id
    WHERE pc.post_id=$1 ORDER BY pc.created_at ASC,pc.id ASC`, [idOf(req.params.postId), req.user.userId]);
  res.json({ ok: true, comments: result.rows });
}));
app.post('/api/posts/:postId/like', authMiddleware, route(async (req, res) => {
  const postId = idOf(req.params.postId), userId = req.user.userId;
  const data = await transaction(async db => {
    // 鎖定貼文，讓同一貼文的按讚切換依序執行。
    if (!(await db.query('SELECT id FROM posts WHERE id=$1 FOR UPDATE', [postId])).rowCount) fail(404, '找不到這篇貼文');
    const deleted = await db.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2 RETURNING id', [postId, userId]);
    const liked = !deleted.rowCount;
    if (liked) await db.query('INSERT INTO post_likes (post_id,user_id) VALUES ($1,$2) ON CONFLICT (post_id,user_id) DO NOTHING', [postId, userId]);
    const count = await db.query('SELECT COUNT(*)::int AS like_count FROM post_likes WHERE post_id=$1', [postId]);
    return { liked, like_count: count.rows[0].like_count };
  });
  res.json({ ok: true, ...data });
}));
app.post('/api/posts/:postId/comments', authMiddleware, route(async (req, res) => {
  const postId = idOf(req.params.postId), content = textOf(req.body.content, 1, 300, '留言');
  if (!(await pg.query('SELECT id FROM posts WHERE id=$1', [postId])).rowCount) fail(404, '找不到這篇貼文');
  const result = await pg.query(`INSERT INTO post_comments (post_id,user_id,content) VALUES ($1,$2,$3)
    RETURNING id,post_id,user_id,content,created_at`, [postId, req.user.userId, content]);
  const user = (await pg.query('SELECT nickname,username FROM users WHERE id=$1', [req.user.userId])).rows[0];
  res.status(201).json({ ok: true, comment: { ...result.rows[0], nickname: user?.nickname || user?.username || '使用者' } });
}));
app.get('/api/posts/restaurants/search', authMiddleware, route(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, restaurants: [] });
  const result = await pg.query('SELECT id,name,address FROM restaurants WHERE name ILIKE $1 ORDER BY rating DESC NULLS LAST,name ASC LIMIT 10', [`%${q}%`]);
  res.json({ ok: true, restaurants: result.rows });
}));

// API 路由不存在時應回 JSON，而不是前端 HTML。
app.use('/api', (req, res) => res.status(404).json({ok:false,error:'API 路由不存在'}));

// 統一處理驗證、上傳及伺服器錯誤，不把 SQL 細節傳給前端。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? '每張照片不能超過 5MB'
      : err.code === 'LIMIT_UNEXPECTED_FILE' ? '最多 5 張圖片，請確認圖片欄位名稱為 images' : '圖片上傳失敗';
    return res.status(400).json({ ok: false, error: message });
  }
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(`${req.method} ${req.path}:`, err.message);
  res.status(status).json({ ok: false, error: status < 500 || err.status ? err.message : '伺服器錯誤，請稍後再試' });
});
pg.on('error', error => console.error('PostgreSQL pool error:', error.message));
async function start() {
  try {
    await pg.query('SELECT 1');
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log('✅ PostgreSQL connected');
      console.log('✅ Health: /api/health | Restaurants: /api/restaurants');
      console.log('✅ AI: POST /api/gpt | Posts: /api/posts');
    });
  } catch (error) {
    console.error('❌ Failed to connect PostgreSQL:', error.message);
    await pg.end();
    process.exit(1);
  }
}
start();
