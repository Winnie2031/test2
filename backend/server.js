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
app.use(express.json());
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

const SYSTEM_PROMPT = `你是「食在中原」AI 餐廳推薦助手。
請使用繁體中文，且只能根據系統提供的餐廳資料進行推薦與回答。
不可編造不存在的餐廳、價格、評分、評論人數或營業時間。

【一、使用者需求優先】
1. 優先根據使用者指定的餐點類型、價格、地點及營業需求篩選餐廳。
2. 使用者明確指定的條件，優先於餐廳評分及推薦分數。
3. 不得為了增加推薦數量，而加入明顯不符合需求的餐廳。
4. 如果沒有符合條件的餐廳，應明確告知，不可自行編造或放寬條件。

【二、營業時間與營業狀態】
1. 參考系統提供的 business_status、open_status 與營業時間資訊。
2. 已知永久停業或暫時停業的餐廳，不得推薦。
3. 如果使用者明確要求「現在營業」、「目前有開」或類似條件，只能推薦 open_status 為 open 的餐廳。
4. open_status 為 closed 代表目前休息中，不代表永久停業。
5. 如果使用者沒有要求目前營業，休息中的餐廳仍可以推薦，但營業中的餐廳優先。
6. open_status 為 unknown 時，不得宣稱該餐廳目前正在營業。
7. 不得自行推測或編造營業時間。

【三、評分與評論人數可信度】
1. 評分使用 rating，評論人數使用 user_ratings_total，不可混淆。
2. recommendation_score 已由程式綜合考慮評分、評論人數可信度與營業狀態。
3. 一般推薦時，優先參考 recommendation_score 排序，但使用者需求的相關性永遠優先。
4. 不可只因為餐廳有 5 顆星，就認定它優於評論人數較多、評分穩定的餐廳。
5. 評論少於 20 則的餐廳仍然可以推薦，不可僅因評論數不足 20 則就排除。
6. 如果所有符合條件的餐廳評論數都很少，仍然應推薦這些餐廳，並參考 recommendation_score 排序。
7. 若使用者詢問評論最多或評分最高的餐廳，應依對應欄位比較，不可混用。

【四、一般推薦數量】
1. 一般推薦不設定固定推薦間數上限。
2. 請盡可能找出候選清單中所有真正符合使用者需求的餐廳。
3. 不要習慣性地只推薦 3～5 間餐廳。
4. 如果有 20 間符合條件，可以推薦 20 間；如果有 30 間符合條件，可以推薦 30 間。
5. 如果只有 3 間符合條件，就推薦這 3 間，不必湊數。
6. 使用者沒有指定數量時，應優先完整涵蓋符合條件的候選餐廳，而不是只挑少數代表性店家。
7. 使用者指定推薦數量時，優先遵守指定數量；若符合條件的店家不足，就推薦實際符合的數量。
8. 評分較低或評論較少的餐廳，只要符合使用者需求，仍可列入推薦，但可以排在後面。
9. 推薦數量不得超過系統實際提供的候選餐廳數量。

【五、一般推薦輸出格式】
1. 回覆內容使用簡短、自然的繁體中文，避免冗長介紹。
2. 不需要逐一列出所有推薦店家的完整名稱，餐廳會由前端顯示。
3. 為降低傳輸長度，請在回覆最後輸出 PICKS 標記。
4. PICKS 中的數字代表候選餐廳清單的 index，從 0 開始計算。
5. PICKS 必須包含所有你選出的餐廳編號，並以 | 分隔。
6. PICKS 的編號順序代表推薦優先順序。
7. 不得輸出候選清單中不存在的編號。
8. 不得重複輸出相同編號。
9. 不可因為 PICKS 標記過長，就自行將推薦數量縮減成 3～5 間。

正確格式範例：
推薦這些符合需求的餐廳，已依推薦分數及營業狀態排序。
<<<PICKS:0|2|5|8|11|15>>>

如果沒有符合條件的餐廳：
目前沒有符合條件的餐廳。
<<<PICKS:>>>

【六、對話追問規則】
1. 如果使用者正在追問上一輪推薦結果，只能討論系統指定的候選餐廳。
2. 不得自行新增其他餐廳。
3. 詢問評分時使用 rating 比較。
4. 詢問評論人數時使用 user_ratings_total 比較。
5. 詢問價格時使用 price_level 比較，但不可將價格級距視為實際菜單售價。
6. 追問時正常回答問題，不需要輸出 PICKS 標記。

請確實遵守上述規則，特別是一般推薦不設定固定間數上限，以及評論較少的餐廳仍有推薦機會。`;


// ⭕ 修改後：支援對話歷史（連貫記憶）
app.post('/api/gpt', route(async (req, res) => {
  if (!client) fail(503, 'AI 尚未設定，請確認 OPENAI_API_KEY');
  const question = textOf(req.body.question, 1, 5000, '問題');
  const userId = optionalUser(req)?.userId || null;
  
  // 1. 從前端取得歷史對話紀錄 (預設為空陣列)
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  let currentConvId = req.body.conversationId ? idOf(req.body.conversationId) : null;
  if (userId && currentConvId) {
    if (!(await pg.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2', [currentConvId, userId])).rowCount)
      fail(403, '無權限使用這筆對話');
  }
  const context = typeof req.body.contextStores === 'string' ? req.body.contextStores : JSON.stringify(req.body.contextStores || []);

  // 僅使用資料庫可驗證的餐廳資料進行比較，不信任前端自行提供的評分
  const isFollowUp = req.body.isFollowUp === true;
  const allowedNames = Array.isArray(req.body.allowedNames)
    ? [...new Set(req.body.allowedNames.filter(name => typeof name === 'string' && name.length <= 200))].slice(0, 100)
    : [];
  let allowedStores = [];
  if (isFollowUp && allowedNames.length) {
    const found = await pg.query(
      'SELECT name,rating,user_ratings_total,price_level,address FROM restaurants WHERE name = ANY($1::text[])',
      [allowedNames]
    );
    allowedStores = allowedNames.map(name => found.rows.find(store => store.name === name)).filter(Boolean);
  }

  const generalCandidates = !isFollowUp ? (() => {
    try {
      const rows = JSON.parse(context);
      return Array.isArray(rows) ? rows.slice(0, 100) : [];
    } catch { return []; }
  })() : [];

  const byReviews = /(評價人數|評論數|評論人數|最多人|較多人|多少人|人數|點評)/.test(question);
  const byRating = /(評分|評價高|評價最|星等|幾顆星|最高分)/.test(question);
  const byCheapest = /(最便宜|價格最低|最低價)/.test(question);
  const byExpensive = /(最貴|價格最高)/.test(question);
  let replyText;

  if (!isFollowUp && generalCandidates.length === 0) {
    replyText = '目前沒有符合條件的餐廳，請嘗試放寬搜尋條件。<<<SEARCH:>>>';
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
      ...history.slice(-20).filter(msg => msg && ['assistant', 'user'].includes(msg.role) && typeof msg.content === 'string')
        .map(msg => ({ role: msg.role, content: msg.content.slice(0, 4000) })),
      { role: 'user', content: `【${isFollowUp ? '只能討論以下餐廳' : '候選餐廳清單'}】：\n${candidatesText}\n【問題】：${question}` }
    ];
    const response = await client.responses.create({
      model: 'gpt-4.1-mini', input: inputMessages, max_output_tokens: 4000
    });
    const rawText = response.output_text?.trim();
    if (!rawText) fail(502, 'AI 未回傳有效內容');

    if (isFollowUp) {
      // 追問保留文字回答，不強制改變原有的單店比較功能。
      const visible = rawText.replace(/<<<PICKS:[^>]*>>>/g, '').trim();
      replyText = visible;
    } else {
      const match = rawText.match(/<<<PICKS:([^>]*)>>>/);
      if (!match) fail(502, 'AI 回傳格式不完整，請再試一次');
      const indices = [...new Set(match[1].split('|').map(s => s.trim())
        .filter(s => /^\d+$/.test(s)).map(Number))]
        .filter(i => Number.isSafeInteger(i) && i >= 0 && i < generalCandidates.length);
      // 無額外 slice(0, 5/10/20)：最多可選出所有 100 間候選的符合店家
      const suggestedNames = [...new Set(indices.map(i => generalCandidates[i].name))];
      const visible = rawText.replace(/<<<PICKS:[^>]*>>>/g, '').trim().slice(0, 500);
      replyText = visible + `\n<<<SEARCH:${suggestedNames.join('|')}>>>`;
    }
  }

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
  
  res.json({ ok: true, reply: replyText, conversationId: currentConvId });
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
