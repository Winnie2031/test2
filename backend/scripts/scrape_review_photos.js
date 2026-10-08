require('dotenv').config();
const { chromium } = require('playwright');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const path = require('path');
const args = process.argv.slice(2);
const option = (name, fallback) => args.find(x => x.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const limit = Number(option('limit', 1));
const id = Number(option('id', 0));
const maxScrolls = Number(option('max-scrolls', 300));
const all = args.includes('--all');
if (![limit, id, maxScrolls].every(Number.isSafeInteger) || limit < 1 || id < 0 || maxScrolls < 1) throw new Error('參數需為有效正整數');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
  keepAlive: true,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 10000
});

// 避免閒置連線斷線時整支程式退出。
pool.on('error', error => {
  console.warn('資料庫閒置連線中斷：', error.message);
});
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS google_review_photo_imports (
    id BIGSERIAL PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    google_review_id TEXT NOT NULL, author_name TEXT, rating NUMERIC, content TEXT,
    photo_index INTEGER NOT NULL, cloudinary_url TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (restaurant_id, google_review_id, photo_index))`);
  await pool.query(`ALTER TABLE google_review_photo_imports
    ADD COLUMN IF NOT EXISTS published_text TEXT,
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_rank INTEGER,
    ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
}
async function openLatest(page, restaurant) {
  const url = new URL(
    'https://www.google.com/maps/search/'
  );

  url.search = new URLSearchParams({
    api: '1',
    query: restaurant.name,
    query_place_id: restaurant.google_place_id,
    hl: 'zh-TW'
  }).toString();

  await page.goto(url.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });

  await page
    .getByRole('button', {
      name: /則評論|篇評論|reviews|評論/i
    })
    .first()
    .click({ timeout: 25000 });

  await page
    .locator('[data-review-id]')
    .first()
    .waitFor({
      state: 'visible',
      timeout: 30000
    });

  await page
    .getByRole('button', {
      name: /排序|Sort/i
    })
    .first()
    .click({ timeout: 15000 });

  const newest = page
    .locator('[role="menuitemradio"]')
    .filter({ hasText: /最新|Newest/i })
    .first();

  await newest.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await newest.click({ timeout: 15000 });

  // 等待選單關閉，不使用 aria-checked 判斷。
  await newest.waitFor({
    state: 'hidden',
    timeout: 15000
  });

  // 留時間讓 Google 更新排序後的評論。
  await pause(2500);

  await page
    .locator('[data-review-id]')
    .first()
    .waitFor({
      state: 'visible',
      timeout: 30000
    });

  console.log('  已點選「最新」，開始讀取評論');
}


async function extract(card) {
  const more = card
    .getByRole('button', {
      name: /^(全文|更多|More)$/i
    })
    .first();

  if (await more.count()) {
    await more.click().catch(() => {});
  }

  return card.evaluate(el => {
    const author =
      el.querySelector('.d4r55')
        ?.textContent?.trim() || 'Google 使用者';

    const ratingLabel = el.querySelector(
      '[role="img"][aria-label*="星"], ' +
      '[role="img"][aria-label*="star"]'
    )?.getAttribute('aria-label') || '';

    const dateNode = el.querySelector('time');
    const rawDate = dateNode?.getAttribute('datetime');

    const publishedAt =
      rawDate && !Number.isNaN(Date.parse(rawDate))
        ? new Date(rawDate).toISOString()
        : null;

    const publishedText =
      el.querySelector('.rsqaWe')
        ?.textContent?.trim() ||
      dateNode?.textContent?.trim() ||
      '';

    const photoUrls = [];

    // 只抓帶照片索引的評論照片，不抓作者頭像。
    const photoButtons = el.querySelectorAll(
      'button[data-photo-index]'
    );

    for (const button of photoButtons) {
      const nodes = [
        button,
        ...button.querySelectorAll(
          'img, [style*="background-image"]'
        )
      ];

      for (const node of nodes) {
        const style = node.getAttribute('style') || '';

        const src =
          node.currentSrc ||
          node.getAttribute('src') ||
          style.match(
            /background-image:\s*url\(["']?([^"')]+)/
          )?.[1];

        if (!src) continue;

        try {
          const url = new URL(src);

          if (url.protocol !== 'https:') continue;

          if (!/(^|\.)(googleusercontent\.com|ggpht\.com)$/i
              .test(url.hostname)) {
            continue;
          }

          // 排除常見 Google 帳號頭像網址。
          if (/^\/(?:a|a-)\//i.test(url.pathname)) {
            continue;
          }

          photoUrls.push(src);
        } catch {
          continue;
        }
      }
    }

    return {
      reviewId: el.getAttribute('data-review-id'),
      author,
      rating:
        Number(ratingLabel.match(/\d(?:\.\d)?/)?.[0]) ||
        null,
      content:
        el.querySelector('.wiI7pd')
          ?.textContent?.trim() || '',
      publishedText,
      publishedAt,
      photoUrls: [...new Set(photoUrls)].slice(0, 4)
    };
  });
}


async function collect(page) {
  const seen = new Set();
  const reviews = [];
  let stalled = 0;
  for (let round = 0; round <= maxScrolls; round++) {
    const cards = page.locator('[data-review-id]');
    const before = seen.size;
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      const reviewId = await card.getAttribute('data-review-id');
      if (!reviewId || seen.has(reviewId)) continue;
      await card.scrollIntoViewIfNeeded();
      await pause(150);
      const review = await extract(card);
      seen.add(reviewId);
      if (!review.photoUrls.length) continue;
      if (!review.publishedText && !review.publishedAt) throw new Error('有照片的評論未讀到日期，保留舊資料');
      reviews.push(review);
      if (reviews.length === 5) return { reviews, complete: true, scanned: seen.size };
    }
    if (round === maxScrolls) break;
    const state = await cards.last().evaluate(el => {
      let parent = el.parentElement;
      while (parent && !(parent.scrollHeight > parent.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement;
      if (!parent) return null;
      const before = parent.scrollTop;
      parent.scrollTop += Math.max(600, parent.clientHeight);
      return { bottom: parent.scrollTop + parent.clientHeight >= parent.scrollHeight - 5, moved: before !== parent.scrollTop };
    });
    if (!state) throw new Error('找不到評論捲動區');
    await pause(1200);
    stalled = seen.size === before && state.bottom && !state.moved ? stalled + 1 : 0;
    if (stalled >= 8) return { reviews, complete: true, scanned: seen.size };
  }
  return { reviews, complete: false, scanned: seen.size };
}
async function replace(restaurant, reviews) {
  const rows = [];
  // 先完成所有上傳才開始資料庫交易；任一上傳失敗保留該店舊資料。
  for (const [rank, review] of reviews.entries()) {
    for (const [index, url] of review.photoUrls.entries()) {
      const key = crypto.createHash('sha256').update(`${restaurant.id}:${review.reviewId}:${url}`).digest('hex').slice(0, 32);
      const uploaded = await cloudinary.uploader.upload(url, { public_id: `restaurant_review_photos/${key}`, overwrite: false, resource_type: 'image' });
      rows.push([restaurant.id, review.reviewId, review.author, review.rating, review.content,
        index, uploaded.secure_url, review.publishedText, review.publishedAt, rank + 1]);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM google_review_photo_imports WHERE restaurant_id=$1', [restaurant.id]);
    for (const row of rows) await client.query(`INSERT INTO google_review_photo_imports
      (restaurant_id,google_review_id,author_name,rating,content,photo_index,cloudinary_url,published_text,published_at,review_rank,fetched_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`, row);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function main() {
  for (const key of ['DATABASE_URL','CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET']) {
    if (!process.env[key]) throw new Error(`缺少 ${key}`);
  }
  await ensureTable();
  if (args.includes('--init-only')) { console.log('評論資料表已準備完成'); return; }
    const offset = Number(option('offset', 0));

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('--offset 必須是非負整數');
  }

  const { rows } = await pool.query(`
    SELECT id, name, google_place_id
    FROM restaurants
    WHERE google_place_id IS NOT NULL
      AND google_place_id <> ''
      AND ($1::integer = 0 OR id = $1)
    ORDER BY id
    LIMIT $2 OFFSET $3
  `, [id, all ? null : limit, offset]);
  const browser = await chromium.launchPersistentContext(path.join(__dirname, '.google-review-profile'),
    { headless: false, locale: 'zh-TW', viewport: { width: 1400, height: 900 } });
  let failures = 0;
  try {
    const page = browser.pages()[0] || await browser.newPage();
    for (const [index, restaurant] of rows.entries()) {
      console.log(`[${index + 1}/${rows.length}] ${restaurant.name}`);
      try {
        await openLatest(page, restaurant);
        const result = await collect(page);
        if (!result.complete) throw new Error(`已掃描 ${result.scanned} 則，達捲動上限；請增加 --max-scrolls，保留舊資料`);
        if (!result.reviews.length) throw new Error('沒有取得有照片的評論；保留舊資料');
        await replace(restaurant, result.reviews);
        console.log(`  已更新 ${result.reviews.length} 則有照片評論（掃描 ${result.scanned} 則）`);
      } catch (error) { failures++; console.warn(`  失敗：${error.message}`); }
      await pause(2500);
    }
  } finally { await browser.close(); }
  console.log(`完成：${rows.length - failures} 間成功，${failures} 間未更新`);
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
