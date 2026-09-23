require("dotenv").config();

const { chromium } = require("playwright");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const args = process.argv.slice(2);

const refresh = args.includes("--refresh");

const limitArgument = args.find(arg => arg.startsWith("--limit="));
const limit = limitArgument
  ? Math.max(1, Number(limitArgument.split("=")[1]) || 5)
  : 5;

const weekdays = [
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
  "星期日"
];

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[｜|()（）\-—_·・,，.。'"]/g, "");
}

function namesProbablyMatch(databaseName, googleName) {
  const db = normalizeName(databaseName);
  const google = normalizeName(googleName);

  if (!db || !google) {
    return false;
  }

  return db === google || db.includes(google) || google.includes(db);
}

async function getVisibleLocator(locator) {
  const count = await locator.count();

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);

    if (await item.isVisible().catch(() => false)) {
      return item;
    }
  }

  return null;
}

async function scrollDetailsPanel(page) {
  const panels = [
    page.locator('div[role="main"]').first(),
    page.locator(".m6QErb.DxyBCb").first()
  ];

  for (const panel of panels) {
    if (!(await panel.count())) {
      continue;
    }

    for (let i = 0; i < 10; i++) {
      await panel.evaluate(element => {
        element.scrollBy(0, 450);
      }).catch(() => {});

      await sleep(400);
    }
  }
}

async function getGoogleRestaurantName(page) {
  const selectors = [
    "h1.DUwDvf",
    'h1[class*="DUwDvf"]',
    "h1"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    if (await locator.isVisible().catch(() => false)) {
      const name = await locator.textContent();

      if (name?.trim()) {
        return name.trim();
      }
    }
  }

  return null;
}

async function clickWeekday(page, weekday) {
  const dayIndex = weekdays.indexOf(weekday);

  if (dayIndex === -1) {
    return false;
  }

  // 找熱門時段旁邊目前顯示星期幾的按鈕
  const possibleButtons = page.locator(
    'button, [role="button"], [role="combobox"]'
  ).filter({
    hasText: /星期[一二三四五六日]/
  });

  const dayButton = await getVisibleLocator(possibleButtons);

  if (!dayButton) {
    console.log(`   ⚠️ 找不到星期下拉按鈕`);
    return false;
  }

  await dayButton.click({
    force: true
  });

  await sleep(500);

  // 直接點擊真正可操作的外層選項
  const option = page.locator(
    `[role="menuitemradio"][data-index="${dayIndex}"]`
  );

  if (!(await option.count())) {
    await page.keyboard.press("Escape").catch(() => {});
    console.log(`   ⚠️ 找不到 ${weekday} 的選項`);
    return false;
  }

  await option.first().click({
    force: true
  });

  await sleep(800);

  return true;
}

async function readVisiblePopularBars(page) {
  const labels = await page.locator("[aria-label]").evaluateAll(elements => {
    return elements
      .filter(element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map(element => element.getAttribute("aria-label"))
      .filter(Boolean);
  });

  const result = [];
  const usedHours = new Set();

  for (const label of labels) {
    // 範例：18時的繁忙程度通常為 93%。
    const match = label.match(
      /(\d{1,2})\s*時.*?繁忙程度通常為\s*(\d{1,3})\s*%/
    );

    if (!match) {
      continue;
    }

    const hour = Number(match[1]);
    const percent = Number(match[2]);

    if (
      hour < 0 ||
      hour > 23 ||
      percent < 0 ||
      percent > 100 ||
      usedHours.has(hour)
    ) {
      continue;
    }

    usedHours.add(hour);

    result.push({
      hour,
      percent
    });
  }

  return result.sort((a, b) => a.hour - b.hour);
}

async function scrapeRestaurant(page, restaurant) {
  const mapUrl =
    "https://www.google.com/maps/search/?api=1" +
    "&query=" +
    encodeURIComponent(restaurant.name) +
    "&query_place_id=" +
    encodeURIComponent(restaurant.google_place_id) +
    "&hl=zh-TW";

  await page.goto(mapUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await sleep(8000);
  await scrollDetailsPanel(page);

  const googleName = await getGoogleRestaurantName(page);

  if (!googleName) {
    throw new Error("讀不到 Google Maps 店名");
  }

  console.log(`   Google 店名：${googleName}`);

  if (!namesProbablyMatch(restaurant.name, googleName)) {
    throw new Error(
      `名稱不一致，資料庫：${restaurant.name}，Google：${googleName}`
    );
  }

// 熱門時段主要放在 aria-label，不一定是一般文字
const popularBars = page.locator(
  '[aria-label*="繁忙程度通常為"], ' +
  '[aria-label*="熱門時段"], ' +
  '[aria-label*="busy"]'
);

// 最多等待 8 秒，讓熱門時段載入
await popularBars
  .first()
  .waitFor({
    state: "attached",
    timeout: 8000
  })
  .catch(() => {});

const popularBarCount = await popularBars.count();

console.log(`   偵測到熱門時段相關元素：${popularBarCount} 個`);

if (popularBarCount === 0) {
  return {
    available: false,
    google_name: googleName,
    scraped_at: new Date().toISOString(),
    reason: "Google Maps 沒有提供熱門時段",
    days: {}
  };
}

  const days = {};

  for (const weekday of weekdays) {
    const clicked = await clickWeekday(page, weekday);

    if (!clicked) {
      console.log(`   ⚠️ 無法切換到 ${weekday}`);
      days[weekday] = [];
      continue;
    }

    const values = await readVisiblePopularBars(page);
    days[weekday] = values;

    console.log(`   ${weekday}：${values.length} 個時段`);
  }

  const totalBars = Object.values(days).reduce(
    (sum, values) => sum + values.length,
    0
  );

  return {
    available: totalBars > 0,
    google_name: googleName,
    scraped_at: new Date().toISOString(),
    days
  };
}

async function saveResult(restaurantId, data) {
  await pool.query(
    `
      UPDATE restaurants
      SET
        popular_times_json = $1::jsonb,
        popular_times_updated_at = NOW()
      WHERE id = $2
    `,
    [JSON.stringify(data), restaurantId]
  );
}

async function main() {
  let browser;

  try {
    console.log(`本次最多處理 ${limit} 間餐廳`);
    console.log(refresh ? "模式：全部重新抓取" : "模式：只抓尚未處理");

    const query = `
      SELECT id, name, google_place_id
      FROM restaurants
      WHERE google_place_id IS NOT NULL
        AND google_place_id <> ''
        ${refresh ? "" : "AND popular_times_json IS NULL"}
      ORDER BY id
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    const restaurants = result.rows;

    if (restaurants.length === 0) {
      console.log("✅ 沒有需要處理的餐廳");
      return;
    }

    browser = await chromium.launch({
      headless: false
    });

    const context = await browser.newContext({
      locale: "zh-TW",
      viewport: {
        width: 1400,
        height: 900
      }
    });

    const page = await context.newPage();

    let successCount = 0;
    let failureCount = 0;

    for (let index = 0; index < restaurants.length; index++) {
      const restaurant = restaurants[index];

      console.log(
        `\n[${index + 1}/${restaurants.length}] ${restaurant.name}`
      );

      try {
        const data = await scrapeRestaurant(page, restaurant);

        await saveResult(restaurant.id, data);

        successCount++;

        if (data.available) {
          console.log("   ✅ 熱門時段已存入資料庫");
        } else {
          console.log("   ℹ️ 此餐廳沒有熱門時段");
        }
      } catch (error) {
        failureCount++;
        console.log(`   ❌ ${error.message}`);
        console.log("   這間保持 NULL，下次可以重新抓取");
      }

      // 每間餐廳之間暫停，降低請求頻率
      if (index < restaurants.length - 1) {
        console.log("   等待 6 秒……");
        await sleep(6000);
      }
    }

    console.log("\n========== 執行完成 ==========");
    console.log(`成功處理：${successCount}`);
    console.log(`失敗：${failureCount}`);
  } catch (error) {
    console.error("❌ 程式發生錯誤：", error);
  } finally {
    if (browser) {
      await browser.close();
    }

    await pool.end();
  }
}

main();