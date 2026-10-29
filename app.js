let currentCategories = [];
let currentPriceLevels = [];
let stores = [];
let likedStores = [];
let randomStores = [];
let currentConversationId = null; 

let aiHistoryMessages = [];

let lastRecommendedNames = [];
let activeMenuRestaurantName = ""; // 最近正在討論餐點的店家；與餐廳推薦名單分開
let lastFocusedNames = []; // 最近一次追問實際顯示的餐廳（與完整推薦名單分開）
let rejectedRestaurantNames = []; // 對話中使用者明確拒絕的餐廳；後續追問持續排除

function getToken() {
  return localStorage.getItem("token");
}

const priceMap = {
  1: "NT$100~200",
  2: "NT$200~400",
  3: "NT$400~600",
  4: "NT$600以上",
};

// 統整分類關鍵字對應表
const categoryMap = {
  "麵食": ["麵", "拉麵", "牛肉麵", "烏龍麵", "義大利麵"],
  "飲料": ["茶", "飲料", "鮮奶", "可不可", "50嵐", "清心", "麻古"],
  "早餐": ["早餐", "漢堡", "弘爺", "美而美"],
  "韓式": ["韓", "韓式"],
  "火鍋": ["火鍋", "鍋", "三媽"],
  "日式": ["壽司", "丼", "拉麵", "日式"]
};

let userPos = null;
let isSending = false;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}  // 距離計算

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function getUserLocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };
      render();
    },
    () => {
      userPos = null;
      render();
    },
    {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 60000,
    }
  );
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null;

  const hour = parseInt(timeStr.slice(0, 2), 10);
  const minute = parseInt(timeStr.slice(2, 4), 10);

  return hour * 60 + minute;
}  // 營業時間判斷

function isOpenNow(openingHoursJson) {
  if (!openingHoursJson) return null;

  let data;

  try {
    data =
      typeof openingHoursJson === "string"
        ? JSON.parse(openingHoursJson)
        : openingHoursJson;
  } catch (err) {
    console.error("opening_hours_json 解析失敗：", err);
    return null;
  }

  // ⭐⭐⭐ 支援兩種格式 ⭐⭐⭐
const periods = Array.isArray(data)
  ? data
  : data?.periods;

if (!Array.isArray(periods)) {
  return null;
}

// Google 全週 24 小時營業格式：
// 星期日 00:00 開始，沒有關店時間。
if (
  periods.length === 1 &&
  periods[0]?.open?.day === 0 &&
  periods[0].open.time === "0000" &&
  periods[0].close == null
) {
  return true;
}

  const now = new Date();
  const today = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const period of periods) {
    if (!period.open) continue;
    if (Number(period.open.day) !== today) continue;

    const openMinutes = timeToMinutes(period.open.time);

    if (openMinutes === null) continue;

    if (!period.close) {
      return true;
    }

    const closeMinutes = timeToMinutes(period.close.time);
    const closeDay = Number(period.close.day);

    if (closeMinutes === null) continue;

    if (closeDay === today) {
      if (
        nowMinutes >= openMinutes &&
        nowMinutes < closeMinutes
      ) {
        return true;
      }
    } else {
      if (nowMinutes >= openMinutes) {
        return true;
      }
    }
  }

  const yesterday = (today + 6) % 7;

  for (const period of periods) {
    if (!period.open || !period.close) continue;

    if (
      Number(period.open.day) === yesterday &&
      Number(period.close.day) === today
    ) {
      const closeMinutes = timeToMinutes(period.close.time);

      if (
        closeMinutes !== null &&
        nowMinutes < closeMinutes
      ) {
        return true;
      }
    }
  }

  return false;
}

// ===== AI 推薦：使用現有營業時間與可信評分 =====
const AI_MIN_REVIEW_COUNT = 20; // 優先門檻；若全部低於 20 則，仍會推薦評論較少的餐廳

function getAiOpenStatus(store) {
  if (store.business_status === "CLOSED_PERMANENTLY") return "permanently_closed";
  if (store.business_status === "CLOSED_TEMPORARILY") return "temporarily_closed";
  const result = isOpenNow(store.opening_hours_json);
  return result === true ? "open" : result === false ? "closed" : "unknown";
}

function getAiRecommendationScore(store) {
  const r = Number(store.rating);
  const v = Number(store.user_ratings_total);
  // 未提供評分或評論數的店家可作備用候選，不把缺失資料當成 5 星
  const count = Number.isFinite(v) && v >= 0 ? v : 0;
  const rating = Number.isFinite(r) && r >= 0 && r <= 5 ? r : 4.0;
  // 貝氏平均：評論越少，評分越接近保守基準 4.0
  const adjustedRating = (count * rating + 30 * 4.0) / (count + 30);
  const openBonus = getAiOpenStatus(store) === "open" ? 0.15 : 0;
  return adjustedRating + openBonus;
}

function getOpenStatusHtml(store) {
  if (store.business_status === "CLOSED_PERMANENTLY") {
    return `<p class="open-status closed">🔴 永久停業</p>`;
  }

  if (store.business_status === "CLOSED_TEMPORARILY") {
    return `<p class="open-status closed">🟡 暫時停業</p>`;
  }

  const openStatus = isOpenNow(store.opening_hours_json);

  if (openStatus === true) {
    return `<p class="open-status open">🟢 營業中</p>`;
  }

  if (openStatus === false) {
    return `<p class="open-status closed">🔴 休息中</p>`;
  }

  if (store.business_status === "OPERATIONAL") {
    return `<p class="open-status unknown">⚪ 營業時間未知</p>`;
  }

  return `<p class="open-status unknown">⚪ 狀態未知</p>`;
}
function render() {
  const keyword = (document.getElementById("search")?.value || "").trim();
  const container = document.getElementById("cards");

  if (!container) return;

  container.innerHTML = "";

  const displayStores = randomStores.length > 0 ? randomStores : stores;

  displayStores
    .filter((s) => {
      const matchesKeyword =
        !keyword ||
        (s.name || "").includes(keyword) ||
        (s.address || "").includes(keyword);

      const matchesCategory =
  currentCategories.length === 0 ||
  currentCategories.some(tag =>
    Array.isArray(s.tags)
      ? s.tags.includes(tag)
      : String(s.tags || "").includes(tag)
  );

      const matchesPrice =
        currentPriceLevels.length === 0 ||
        currentPriceLevels.includes(Number(s.price_level));

      return matchesKeyword && matchesCategory && matchesPrice;
    })
    .sort((a, b) => {
      const aLiked = likedStores.includes(a.id) ? 1 : 0;
      const bLiked = likedStores.includes(b.id) ? 1 : 0;

      if (bLiked !== aLiked) return bLiked - aLiked;

      function openScore(s) {
        if (s === true) return 2;
        if (s === false) return 1;
        return 0;
      }

      const aOpen = isOpenNow(a.opening_hours_json);
      const bOpen = isOpenNow(b.opening_hours_json);

      const aScore = openScore(aOpen);
      const bScore = openScore(bOpen);

      if (bScore !== aScore) return bScore - aScore;

      if (userPos) {
        const aDist =
          a.lat && a.lng
            ? distanceMeters(
                userPos.lat,
                userPos.lng,
                Number(a.lat),
                Number(a.lng)
              )
            : Infinity;

        const bDist =
          b.lat && b.lng
            ? distanceMeters(
                userPos.lat,
                userPos.lng,
                Number(b.lat),
                Number(b.lng)
              )
            : Infinity;

        return aDist - bDist;
      }

      return 0;
    })
    .forEach((store) => {
      const card = document.createElement("div");
      card.className = "card";

      card.onclick = () => {
        window.location.href = `detail.html?id=${store.id}`;
      };

      const isLiked = likedStores.includes(store.id);

      const img =
        store.image_url || 
        "https://via.placeholder.com/220x150?text=No+Photo";

      let distM = null;

      if (userPos && store.lat && store.lng) {
        distM = distanceMeters(
          userPos.lat,
          userPos.lng,
          Number(store.lat),
          Number(store.lng)
        );
      }

      const distBadge =
        distM != null
          ? `<div class="distance-badge">📏 ${formatDistance(distM)}</div>`
          : "";

      card.innerHTML = `
        <div class="note-icon">📝</div>
        <div class="heart">${isLiked ? "❤️" : "🤍"}</div>

        <img
          src="${img}"
          alt="${store.name || ""}"
          loading="lazy"
          onerror="this.onerror=null;this.src='https://via.placeholder.com/220x150?text=No+Photo';"
        >

        <div class="card-info">
          <h3>${store.name || "(未命名)"}</h3>

          ${store.address ? `<p>📍 ${store.address}</p>` : ""}

          ${
            store.rating != null
              ? `<p>⭐ ${store.rating} (${store.user_ratings_total || 0}人評分)</p>`
              : ""
          }

          ${
            store.price_level != null
              ? `<p>💲 ${priceMap[store.price_level] || store.price_level}</p>`
              : ""
          }

          ${getOpenStatusHtml(store)}
        </div>

        ${distBadge}
      `;

      // 備忘錄點擊事件
      card.querySelector(".note-icon").onclick = (e) => {
        e.stopPropagation();

        const token = getToken();
        if (!token) {
          alert("請先登入才能填寫備忘錄！");
          switchToLogin();
          return;
        }

        openNoteModal(store.id, store.name);
      };

      // 愛心收藏點擊事件
      card.querySelector(".heart").onclick = async (e) => {
        e.stopPropagation();

        const token = getToken();

        if (!token) {
          alert("請先登入才能收藏");
          switchToLogin(); 
          return;
        }

        try {
          if (likedStores.includes(store.id)) {
            await fetch(`/api/favorites/${store.id}`, {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            likedStores = likedStores.filter((id) => id !== store.id);
          } else {
            await fetch(`/api/favorites/${store.id}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            likedStores.push(store.id);
          }

          render();
        } catch (err) {
          console.error("收藏失敗：", err);
          alert("收藏失敗, 請稍後再試");
        }
      }; 

      container.appendChild(card); 
    });
}  // 主渲染 

async function loadStores() {
  try {
    const res = await fetch("/api/restaurants?limit=500");
    const payload = await res.json();

    if (!payload.ok) throw new Error(payload.error);

    stores = payload.data || [];
    render();
  } catch (err) {
    console.error("載入餐廳失敗：", err);

    const container = document.getElementById("cards");

    if (container) {
      container.innerHTML = `
        <p style="color: #e53e3e;">
          ⚠️ 餐廳資料載入失敗：${err.message}
        </p>
      `;
    }
  }
}  // 載入餐廳資料

async function loadFavorites() {
  const token = getToken();

  if (!token) {
    likedStores = [];
    localStorage.removeItem("likedStores");
    return;
  }

  try {
    const res = await fetch("/api/favorites", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || "載入收藏失敗");
    }

    likedStores = payload.data || [];
  } catch (err) {
    console.error("載入收藏失敗：", err);
    likedStores = [];
  }
}  // 收藏資料



// 分類標籤：支援複選
function filterByTag(tag, btn) {
  randomStores = [];

  const container = document.getElementById("categoryContainer");
  if (!container || !btn) return;

  const allBtn = container.querySelector('[data-category="all"]');

  // 點「全部」：清除所有分類
  if (tag === "全部") {
    currentCategories = [];

    container.querySelectorAll(".category-btn").forEach(button => {
      button.classList.remove("active");
    });

    allBtn?.classList.add("active");

    render();
    return;
  }

  // 再點一次已選標籤，就取消選取
  if (currentCategories.includes(tag)) {
    currentCategories = currentCategories.filter(
      selectedTag => selectedTag !== tag
    );

    btn.classList.remove("active");
  } else {
    currentCategories.push(tag);
    btn.classList.add("active");
  }

  // 沒有選任何分類時，恢復「全部」
  allBtn?.classList.toggle("active", currentCategories.length === 0);

  render();
}

function filterByPrice(level) {
  level = Number(level);

  const btn = event.currentTarget;

  // 已經選過 → 取消
  if (currentPriceLevels.includes(level)) {

    currentPriceLevels = currentPriceLevels.filter(
      p => p !== level
    );

    btn.classList.remove("active");

  } else {

    // 還沒選過 → 加入
    currentPriceLevels.push(level);

    btn.classList.add("active");
  }

  randomStores = [];

  render();
}

document.getElementById("search")?.addEventListener("input", () => {
  randomStores = [];
  render();
});

const randomBtn = document.getElementById("randomBtn");
const searchInput = document.getElementById("search");
const resetRandomBtn = document.getElementById("resetRandomBtn"); 

// ==================== 🎲 骰子：隨機推薦功能 ====================
if (randomBtn) {
  randomBtn.addEventListener("click", () => {
    randomStores = [];
    
    // 1. 先根據「目前分類」初步篩選所有餐廳 (🌟 修正這裡：使用 currentCategories 陣列)
    let baseStores = [...stores];
    if (currentCategories && currentCategories.length > 0) {
      baseStores = baseStores.filter(store =>
        currentCategories.some(tag =>
          Array.isArray(store.tags)
            ? store.tags.includes(tag)
            : String(store.tags || "").includes(tag)
        )
      );
    }

    if (baseStores.length === 0) {
      alert("目前沒有符合條件的餐廳！");
      return;
    }

    // 2. 將名單分為「營業中」與「非營業中」兩組
    let openStores = baseStores.filter(
      store => isOpenNow(store.opening_hours_json) === true
    );
    let closedStores = baseStores.filter(
      store => isOpenNow(store.opening_hours_json) !== true
    );

    // 3. 兩組名單各自洗牌打亂
    openStores = openStores.sort(() => Math.random() - 0.5);
    closedStores = closedStores.sort(() => Math.random() - 0.5);

    // 4. 完美合併：營業中優先排前面，不足的由休息中的補齊，最後統一抽出前 5 筆
    randomStores = [...openStores, ...closedStores].slice(0, 5);

    // 清空搜尋文字
    if (searchInput) {
      searchInput.value = "";
    }

    render();

    // 🌟 修正：骰子抽完後，務必把「🗑️ 復原按鈕」顯示出來！
    if (resetRandomBtn) {
      resetRandomBtn.style.display = "flex"; 
    }
  });
}

// ==================== 🗑️ 復原按鈕：恢復顯示全部餐廳 ====================
if (resetRandomBtn) {
  resetRandomBtn.addEventListener("click", () => {
    // 1. 清空隨機抽籤的陣列
    randomStores = []; 
    
    // 2. 隱藏自己 (復原按鈕)
    resetRandomBtn.style.display = "none"; 
    
    // 3. 把分類標籤的視覺狀態強制切回「🌟 全部」 (🌟 修正這裡：清空陣列)
    currentCategories = [];
    document.querySelectorAll(".category-btn").forEach((b) => b.classList.remove("active"));
    const allBtn = document.querySelector('.category-btn'); 
    if (allBtn) allBtn.classList.add("active");
    
    // 4. 清空搜尋框並重新渲染畫面
    if (searchInput) searchInput.value = "";
    render();
  });
}

const aiBtn = document.getElementById("aiBtn");
const aiChat = document.getElementById("aiChat");
const aiInput = document.getElementById("aiInput");
const aiSend = document.getElementById("aiSend");
const aiOutput = document.getElementById("aiOutput");

if (aiBtn && aiChat) {
  aiBtn.onclick = () => {
    aiChat.style.display =
      aiChat.style.display === "none" || aiChat.style.display === "" ? "flex" : "none";
  };
}

// ==================== AI 視窗左上角手動拉伸邏輯 ====================
document.addEventListener("DOMContentLoaded", () => {
  const aiChat = document.getElementById("aiChat");
  const resizeHandle = document.getElementById("aiResizeHandle");

  if (!aiChat || !resizeHandle) return;

  let startX, startY, startWidth, startHeight;

  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startWidth = aiChat.offsetWidth;
    startHeight = aiChat.offsetHeight;

    document.addEventListener("mousemove", doDrag);
    document.addEventListener("mouseup", stopDrag);
  });

  function doDrag(e) {
    // 因為視窗貼在右下角 (bottom/right)，向左/向上拉（clientX/Y 變小）時，寬高要變大
    const newWidth = startWidth + (startX - e.clientX);
    const newHeight = startHeight + (startY - e.clientY);

    // 限制最小與最大尺寸
    const minW = 280, maxW = window.innerWidth * 0.9;
    const minH = 350, maxH = window.innerHeight * 0.8;

    if (newWidth >= minW && newWidth <= maxW) {
      aiChat.style.width = `${newWidth}px`;
    }
    if (newHeight >= minH && newHeight <= maxH) {
      aiChat.style.height = `${newHeight}px`;
    }
  }

  function stopDrag() {
    document.removeEventListener("mousemove", doDrag);
    document.removeEventListener("mouseup", stopDrag);
  }
});

// AI 店名查詢：保留「墨竹亭」可匹配「墨竹亭 中原店」的能力。
// 只有完整名稱或有辨識度的店名第一段符合時，才當成指定店家。
function findAiNamedStores(question) {
  const q = question.replace(/\s+/g, "").toLowerCase();
  return stores.filter(store => {
    const name = String(store.name || "").trim();
    if (!name) return false;
    const whole = name.replace(/\s+/g, "").toLowerCase();
    const prefix = name.split(/[\s　（(\-－—]+/)[0].toLowerCase();
    const shortBrand = prefix.slice(0, 3);
    return q.includes(whole) ||
      (prefix.length >= 3 && q.includes(prefix)) ||
      (shortBrand.length === 3 && q.includes(shortBrand));
  });
}

async function sendAiMessage() {
  if (isSending) return;
  if (!aiInput || !aiSend || !aiOutput) return;

  const question = aiInput.value.trim();
  if (!question) return;

  const foodTypes = [
    // 59 個網頁標準標籤
    "飯類", "便當", "丼飯", "咖哩", "滷肉飯", "雞肉飯", "燒臘",
    "麵食", "牛肉麵", "拉麵", "烏龍麵", "義大利麵", "涼麵", "米干／米線", "米干", "米線",
    "早餐", "早午餐", "漢堡", "三明治／吐司", "三明治", "吐司", "輕食",
    "小吃", "水餃", "炸物", "雞排", "臭豆腐", "粥", "饅頭／包子", "饅頭", "包子",
    "火鍋", "麻辣鍋", "燒烤", "串燒", "牛排", "鐵板燒", "海鮮",
    "日式", "韓式", "港式", "泰式", "越南料理", "印度料理", "客家料理", "義式", "美式", "美墨料理",
    "素食", "速食", "壽司", "披薩", "居酒屋", "餐酒館",
    "飲料", "手搖飲", "咖啡", "泰式奶茶",
    "甜點", "冰品", "豆花", "仙草／芋圓", "仙草", "芋圓", "蛋糕", "鬆餅", "麵包／烘焙", "麵包", "烘焙",
    "飯", "麵", "燒肉", "滷味", "炸雞", "午餐", "晚餐", "宵夜", "茶",
    "麥當勞", "肯德基", "摩斯", "摩斯漢堡", "必勝客", "達美樂", "Subway"
  ];

  const timeKeywords = ["營業", "開嗎", "幾點", "關門", "現在"];
  const dineInKeywords = ["內用", "聚餐", "約會", "多人", "單人", "慶生", "聊天"];
  const takeoutKeywords = ["外帶", "帶走", "自取"];
  const deliveryKeywords = ["外送", "送到", "外賣", "叫車"];

  // ----------------【新增：價格關聯詞彙與價位 mapping】----------------
  const priceKeywords = ["100", "200", "300", "400", "500", "600", "元", "塊", "價格", "價位", "預算", "平價", "便宜", "貴", "CP額", "cp值"];
  
  // 判斷用戶輸入包含哪些價位等級 (對應資料庫 price_level: 1, 2, 3, 4)
  const targetPriceLevels = [];
  if (question.includes("100") || question.includes("200") || question.includes("平價") || question.includes("便宜")) {
    targetPriceLevels.push(1); // NT$100~200
  }
  if (question.includes("200") || question.includes("300") || question.includes("400")) {
    targetPriceLevels.push(2); // NT$200~400
  }
  if (question.includes("400") || question.includes("500") || question.includes("600")) {
    targetPriceLevels.push(3); // NT$400~600
  }
  if (question.includes("600") || question.includes("貴") || question.includes("高級")) {
    targetPriceLevels.push(4); // NT$600以上
  }
  // ----------------------------------------------------------------------

  const otherKeywords = [
    "餐廳", "美食", "推薦", "吃", "早餐", "午餐", "晚餐", "宵夜", "飲料", "咖啡",
    "中原", "夜市", "附近", "哪裡", "價格", "價位", "多少", "便宜", "貴", "平價", 
    "預算", "cp值", "划算", "停車", "冷氣", "安靜", "環境", "素食", "辣", "不辣", 
    "健康", "其他", "特色", "口味", "評價", "人氣", "熱門", "排隊", "座位", 
    "位置", "交通", "方便", "舒適",
    ...priceKeywords // 👈 將價格關鍵字整合進去
  ];

  const allKeywords = [
    ...foodTypes, ...timeKeywords, ...dineInKeywords, 
    ...takeoutKeywords, ...deliveryKeywords, ...otherKeywords
  ];

  const namedStores = findAiNamedStores(question);
  // 兩字以上且沒有一般問句詞彙的短文字，視為「可能的店名」，交給資料庫驗證。
  // 不能只用全名 question.includes(name)，否則「墨竹亭」找不到「墨竹亭 中原店」。
  const directNameQuery = question.length >= 2 && question.length <= 40 &&
    !/[？?，,。！!\n]/.test(question) &&
    !/(推薦|幫我|請問|怎麼|如何|什麼|哪間|哪家|餐廳|評分|評價|評論|營業|有開|價格|價位|便宜|點什麼|菜單|招牌|人氣|好吃|介紹|附近|中原附近|早午餐|午餐|晚餐|現在|有沒有|還有|其他)/.test(question) &&
    !foodTypes.includes(question);
  const mentionsStoreName = namedStores.length > 0;
  const menuQuestion = /(都點什麼|點什麼|點些什麼|最多人點|熱門餐點|人氣餐點|招牌菜|必點|菜單|賣什麼)/.test(question);
  const namedRestaurantInfo = mentionsStoreName &&
    /(都點什麼|點什麼|點些什麼|最多人點|菜單|招牌|評分|評價|評論|價格|價位|營業|有開|幾點|電話|地址|在哪|好吃|介紹|怎麼樣)/.test(question);
  // 「150 元還有其他選擇」「那道不辣嗎」是同一家店的餐點追問，
  // 不能被「其他」誤判成其他餐廳推薦。
  const menuContextFollowUp = Boolean(activeMenuRestaurantName) && !mentionsStoreName &&
    !/(重新推薦餐廳|換一家餐廳|其他餐廳|附近餐廳|找新的餐廳)/.test(question) &&
    /(預算|\d+\s*元|\d+\s*塊|不吃辣|不辣|辣度|那一道|那道|這道|餐點|菜色|點什麼|吃什麼|還有其他選擇|其他選擇|其他可以點|其他能點|便宜一點)/.test(question);
  const isRestaurantQuestion = menuContextFollowUp || directNameQuery || mentionsStoreName || allKeywords.some((keyword) =>
    question.includes(keyword)
  );

  if (!isRestaurantQuestion && aiHistoryMessages.length === 0) {
    aiOutput.innerHTML += `
      <p style="color:red;">
        🤖 AI：與餐廳無關，請重新提問
      </p>
      <hr>
    `;
    aiInput.value = "";
    if (aiChat) aiChat.scrollTop = aiChat.scrollHeight;
    return;
  }

  isSending = true;
  aiSend.disabled = true;
  aiSend.textContent = "思考中...";

  currentConversationIsFavorite = false;

  const topStar = document.getElementById('aiActiveStarBtn');
  if (topStar) {
    topStar.style.display = 'none'; 
  }

  const msgId = "msg_" + Date.now(); 
  
  // 1. 抓取目前畫面上已有的對話紀錄（上下文記憶）
  const historyMessages = aiHistoryMessages.slice(-20);
  
  aiOutput.innerHTML += `
    <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed #eee;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
        <strong style="color: #333; flex: 1;">🧑 你：${escapeHtml(question)}</strong>
        <span id="star_${msgId}"></span>
      </div>
      <div id="reply_${msgId}"><p style="color: #888; margin: 0;">思考中...</p></div>
    </div>
  `;

  aiInput.value = "";

  
// 對話追問：保留最初推薦的候選名單，避免重新搜尋全資料庫
  const wantsOther = /(其他|另外|再推薦|重新推薦|換一批|換幾間|還有其他|還有別的)/.test(question);
  const explicitFollowUp = /(以上|上述|剛才|剛剛|前面|上面|這幾間|這些|其中|那間|這間|那家|這家|第一間|第二間|第三間|上一輪|前次推薦|那其他|其他便宜的餐廳中)/.test(question);
  const comparisonFollowUp = /(哪間|哪家|哪一家|兩間|這幾家|哪個最|哪個評分)/.test(question);
  const isRejection = /(不想吃|不要這間|不要那間|不考慮這間|不考慮那間|排除這間|排除那間)/.test(question);
  const asksAlternative = /(還有其他|還有別的|再給.*其他|換一間|換其他|另外推薦)/.test(question);
  // 「那其他便宜的餐廳中，哪間評分最高」是針對上一批替代店家比較，不是要求重新找替代店家。
  const hasComparison = /(哪間|哪家|哪個|評分最高|評論最多|最便宜|最貴)/.test(question);
  const alternativeFollowUp = !menuContextFollowUp && lastRecommendedNames.length > 0 &&
    (isRejection || (asksAlternative && !hasComparison)) &&
    !/(重新推薦全部|重新搜尋|找新的餐廳)/.test(question);
  const newRecommendation = /(推薦|找.*餐廳|介紹.*餐廳)/.test(question) &&
    !explicitFollowUp && !alternativeFollowUp;
  const isFollowUp = !menuContextFollowUp && !directNameQuery && !namedRestaurantInfo &&
    lastRecommendedNames.length > 0 &&
    (alternativeFollowUp || (!newRecommendation &&
      (explicitFollowUp || comparisonFollowUp)));

  // 當使用者拒絕「這間」時，持續保存該餐廳；不應下一輪又出現。
  if (isFollowUp && isRejection && lastFocusedNames.length) {
    rejectedRestaurantNames = [...new Set([
      ...rejectedRestaurantNames,
      ...lastFocusedNames
    ])];
  }
  const asksOpenNow = /(現在.*(營業|有開)|目前.*(營業|有開)|還有營業|還有開|營業中)/.test(question) &&
    !/(不限.*(營業|開)|不管.*(營業|開)|無論.*(營業|開))/.test(question);
  let selectedStores;
  if (isFollowUp) {
    // 比較「那其他便宜的餐廳」要沿用上一輪替代名單，而非全部 29 間。
    const refersToFocusedSet =
      /(那其他|其他便宜|這些|這幾間|這幾家|上述這些|剛才推薦)/.test(question);
    const referenceNames = alternativeFollowUp
      ? lastRecommendedNames
      : ((refersToFocusedSet || /(這間|那間|這家|那家)/.test(question)) && lastFocusedNames.length
          ? lastFocusedNames : lastRecommendedNames);
    selectedStores = referenceNames
      .filter(name => !rejectedRestaurantNames.includes(name))
      .map(name => stores.find(store => store.name === name))
      .filter(Boolean);
  } else {
    const matched = stores.filter(store => {
      const name = store.name || "";
      const tags = Array.isArray(store.tags) ? store.tags.join(" ") : String(store.tags || "");
      return (name && ( question.includes(name) || name.includes(question.trim()))) ||
        foodTypes.some(type => question.includes(type) && (tags.includes(type) || name.includes(type)));
    });
    selectedStores = matched.length ? matched : stores;
    if (wantsOther && lastRecommendedNames.length) {
      selectedStores = selectedStores.filter(store => !lastRecommendedNames.includes(store.name));
    }

    // 開始新的推薦時清除前一主題的拒絕清單
    if (!namedRestaurantInfo && !directNameQuery && !menuContextFollowUp) rejectedRestaurantNames = [];
    // 先依營業需求過濾，不因評論數偏低而把所有店家排除
    selectedStores = selectedStores.filter(store => {
      const status = getAiOpenStatus(store);
      if (status === "permanently_closed" || status === "temporarily_closed") return false;
      if (asksOpenNow && status !== "open") return false;
      return true;
    });

    // 評論數少的店家不排除，改由貝氏校正評分決定優先順序。

    // 營業加分 + 貝氏校正評分，並以評論數做同分時的次排序
    selectedStores = [...selectedStores].sort((a, b) =>
      getAiRecommendationScore(b) - getAiRecommendationScore(a) ||
      Number(b.user_ratings_total || 0) - Number(a.user_ratings_total || 0)
    );
  }

  // AI 最多查看前 100 間候選，最終推薦不另設固定數量上限
  const contextStores = JSON.stringify(selectedStores.slice(0, 100).map(store => ({
    name: store.name,
    rating: store.rating,
    user_ratings_total: store.user_ratings_total,
    price_level: store.price_level,
    address: store.address,
    tags: store.tags,
    business_status: store.business_status,
    opening_hours_json: store.opening_hours_json,
    open_status: getAiOpenStatus(store),
    recommendation_score: Number(getAiRecommendationScore(store).toFixed(3))
  })));


  try {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // 2. 在 fetch 的 body 中加入 history 陣列
    const res = await fetch("/api/gpt", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        question: question,           
        contextStores: contextStores, 
        conversationId: currentConversationId, // 傳送目前的對話 ID
        history: historyMessages,              // 傳送之前的上下文對話
        isFollowUp,
        alternativeFollowUp,
        excludeNames: rejectedRestaurantNames,
        directNameQuery: directNameQuery ? question : null,
        restaurantLookupNames: namedRestaurantInfo ? namedStores.map(store => store.name).slice(0, 30) : [],
        menuQuestion,
        menuFollowUp: menuContextFollowUp,
        menuRestaurantName: menuContextFollowUp ? activeMenuRestaurantName : null,
        allowedNames: isFollowUp ? selectedStores.map(store => store.name) : []
      }),
    });

    const responseText = await res.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error("AI API 非 JSON 回應", res.status, res.url, responseText.slice(0, 600));
      throw new Error(`伺服器未回傳 JSON（HTTP ${res.status}），請檢查 Render Logs`);
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `API 錯誤（HTTP ${res.status}）`);

    // 直接資料庫查到的餐廳可能不在首頁預先載入的前 500 間中。
    if (Array.isArray(data.restaurants)) {
      for (const found of data.restaurants) {
        if (!stores.some(s => s.id === found.id)) stores.push(found);
      }
    }

    // 3. 更新 currentConversationId，確保下次發問屬於同一次對話
    if (data.conversationId) {
      currentConversationId = data.conversationId;
    }

    // 只有真的完成菜單搜尋才更新餐點對話的店家記憶。
    if (typeof data.menuRestaurantName === "string" && data.menuRestaurantName) {
      activeMenuRestaurantName = data.menuRestaurantName;
    } else if (!menuContextFollowUp && !menuQuestion && !namedRestaurantInfo && !directNameQuery) {
      activeMenuRestaurantName = "";
    }
    let replyText = data.reply;
    let recommendedName = "";

    aiHistoryMessages.push(
      { role: "user", content: question },
      { role: "assistant", content: replyText }
    );

    aiHistoryMessages = aiHistoryMessages.slice(-20);

    const searchCommandRegex = /<<<SEARCH:([^>]*)>>>/;
    const match = replyText.match(searchCommandRegex);
    if (match) {
      recommendedName = match[1].trim();
      if (!isFollowUp && !namedRestaurantInfo && !menuContextFollowUp && !menuQuestion) {
        lastRecommendedNames = recommendedName
          ? recommendedName.split("|").map(name => name.trim())
              .filter(name => stores.some(store => store.name === name))
          : [];
      }
      // 追問只更新聚焦餐廳；保留原始推薦的整份名單。
      if (recommendedName) {
        lastFocusedNames = recommendedName.split("|")
          .map(name => name.trim())
          .filter(name => name && !rejectedRestaurantNames.includes(name));
      }
      // 即使 SEARCH 為空，也要移除標記，避免直接顯示在聊天窗。
      replyText = replyText.replace(searchCommandRegex, "").trim();
    }

    const starContainer = document.getElementById(`star_${msgId}`);
    if (starContainer && data.conversationId) {
      starContainer.innerHTML = `<button onclick="toggleAiFavorite(${data.conversationId}, false, this)" style="background:none; border:none; font-size: 1.3rem; cursor: pointer; color: #ccc;" title="加入收藏">☆</button>`;
    }

    const replyContainer = document.getElementById(`reply_${msgId}`);
    if (replyContainer) {
      replyContainer.innerHTML = `<p style="margin: 0; color: #333;"><strong>🤖 AI：</strong>${escapeHtml(replyText)}</p>`;
      
      if (recommendedName) {
        const targetNames = recommendedName.split("|").map(n => n.trim()).filter(Boolean);

        randomStores = targetNames
          .map(name => stores.find(store => store.name === name))
          .filter(Boolean);

        const searchInput = document.getElementById("search");
        if (searchInput) searchInput.value = "";
        // 既有分類/價格篩選不能讓 AI 找到的店家被畫面隱藏。
        currentCategories = [];
        currentPriceLevels = [];
        document.querySelectorAll(".category-btn").forEach(b => b.classList.remove("active"));
        document.querySelector('[data-category="all"]')?.classList.add("active");
        document.querySelectorAll(".price-btn.active").forEach(b => b.classList.remove("active"));
        render();

        replyContainer.innerHTML += `<p style="color:#1f9d55;font-size:0.82rem;margin:4px 0 0;">✅ 已在主畫面顯示 ${randomStores.length} 間餐廳</p>`;

        const resetRandomBtn = document.getElementById("resetRandomBtn");
        if (resetRandomBtn) {
          resetRandomBtn.style.display = "flex";
        }
      }
    }

  
} catch (err) {
  console.error("AI 請求失敗：", err);

  const replyContainer =
    document.getElementById(`reply_${msgId}`);

  if (replyContainer) {
    replyContainer.textContent =
      `AI 回應失敗：${err.message}`;
    replyContainer.style.color = "red";
  }
}


  aiSend.disabled = false;
  aiSend.textContent = "送出";
  isSending = false;
  
  if (aiChat) {
    aiChat.scrollTop = aiChat.scrollHeight;
  }
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (aiSend) {
  aiSend.onclick = sendAiMessage;
}

if (aiInput) {
  aiInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAiMessage();
    }
  });
}

async function init() {
  setupUserIcon();
  await loadFavorites();
  await loadStores();
  getUserLocation();
}

// ============================================================
// 🔐 登入 / 註冊 / 忘記密碼 Modal
// ============================================================

const loginModal = document.getElementById('loginModal');
const registerModal = document.getElementById('registerModal');
const forgotPasswordModal = document.getElementById('forgotPasswordModal');

// 打開登入 Modal
function openLoginModal() {
  if (loginModal) loginModal.style.display = "flex";
  if (registerModal) registerModal.style.display = "none";
  if (forgotPasswordModal) forgotPasswordModal.style.display = "none";
}

// ============================================================
// 🔐 忘記密碼狀態
// ============================================================

// 切換到註冊視窗
function switchToRegister() {
  if (loginModal) loginModal.style.display = 'none';
  if (forgotPasswordModal) forgotPasswordModal.style.display = 'none';
  if (registerModal) registerModal.style.display = 'flex';
}

// 切換到忘記密碼視窗
function switchToForgotPassword() {
  if (loginModal) loginModal.style.display = 'none';
  if (registerModal) registerModal.style.display = 'none';
  if (forgotPasswordModal) forgotPasswordModal.style.display = 'flex';
  
  // 清空輸入框
  document.getElementById("forgot-username").value = "";
  document.getElementById("forgot-phone").value = "";
  document.getElementById("forgot-password").value = "";
  
  // 恢復提示文字狀態
  const hint = document.getElementById("forgotPasswordHint");
  if (hint) {
    hint.textContent = "必須為 4~10 個英數字";
    hint.style.color = "#888";
    hint.style.fontWeight = "normal";
  }
}

// 回登入視窗
function switchToLogin() {
  if (registerModal) registerModal.style.display = "none";
  if (forgotPasswordModal) forgotPasswordModal.style.display = "none";
  if (loginModal) loginModal.style.display = "flex";
}

// 關閉 Modal
function closeModals() {
  if (loginModal) loginModal.style.display = 'none';
  if (registerModal) registerModal.style.display = 'none';
  if (forgotPasswordModal) forgotPasswordModal.style.display = 'none';
  document.querySelectorAll('.modal-overlay input').forEach(input => input.value = '');
}

// 點黑色背景關閉
window.addEventListener(
  "click",
  (e) => {

    if (
      e.target === loginModal ||
      e.target === registerModal ||
      e.target === forgotPasswordModal
    ) {
      closeModals();
    }
  }
);


async function submitForgotPassword() {
  const btn = document.getElementById("forgotBtn");
  const usernameInput = document.getElementById("forgot-username");
  const phoneInput = document.getElementById("forgot-phone");
  const passwordInput = document.getElementById("forgot-password");

  if (!usernameInput || !phoneInput || !passwordInput) return;

  const username = usernameInput.value.trim();
  const phone = phoneInput.value.trim();
  const newPassword = passwordInput.value.trim();
  const hint = document.getElementById("forgotPasswordHint");

  if (!username || !phone || !newPassword) {
    alert("請填寫所有欄位");
    return;
  }

  // 驗證新密碼格式
  const passwordRegex = /^[a-zA-Z0-9]{4,10}$/;
  if (!passwordRegex.test(newPassword)) {
    if (hint) {
      hint.textContent = "❌ 密碼必須為 4~10 個英數字";
      hint.style.color = "#ff3333";
      hint.style.fontWeight = "bold";
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "處理中...";
  }

  try {
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, phone, newPassword })
    });

    const data = await res.json();

    if (res.ok && data.ok) {
      alert("✅ " + data.message);
      switchToLogin(); // 成功後自動跳回登入頁
    } else {
      alert("❌ " + (data.error || "重設密碼失敗"));
    }
  } catch (err) {
    console.error("忘記密碼 API 錯誤：", err);
    alert("❌ 系統連線失敗");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重設密碼";
    }
  }
}

function setupUserIcon() {
  const userIcon = document.getElementById("userIcon");
  const loginItemBtn = document.getElementById("loginItemBtn");
  const editUserItemBtn = document.getElementById("editUserItemBtn");

  const token = localStorage.getItem("token");
  const username = localStorage.getItem("username");
  const nickname = localStorage.getItem("nickname");
  const displayName = nickname || username || "使用者";

  // 👤 右上角頭像
  if (userIcon) {
    // 💡 修正 1：刪除 userIcon.onclick = null; 並強制重新綁定點擊事件！
    userIcon.onclick = function(e) {
      toggleUserDropdown(e);
    };

    if (token) {
      const initial = displayName.charAt(0).toUpperCase();
      // 💡 修正 2：加上 pointer-events: none，防止內層文字擋住手機觸控點擊
      userIcon.innerHTML = `<span style="pointer-events: none;">${initial}</span>`;
      userIcon.style.fontWeight = "bold";
    } else {
      userIcon.innerHTML = `<span class="btn-icon-emoji" style="pointer-events: none;">👤</span>`;
    }
  }

  // 🔐 已登入 / 未登入選單切換
  if (token) {
    if (loginItemBtn) {
      loginItemBtn.innerHTML = `🚪 登出 (${displayName})`;
      loginItemBtn.onclick = handleLogout;
    }
    if (editUserItemBtn) {
      editUserItemBtn.style.display = "flex";
      editUserItemBtn.onclick = openEditUserModal;
    }
  } else {
    if (loginItemBtn) {
      loginItemBtn.innerHTML = `🔑 登入 / 會員中心`;
      loginItemBtn.onclick = openLoginModal;
    }
    if (editUserItemBtn) {
      editUserItemBtn.style.display = "none";
    }
  }
}

// ==================== 👤 使用者下拉選單 ====================
function toggleUserDropdown(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation(); // 阻止事件冒泡，避免點擊瞬間被全域 click 關閉
  }

  const container = document.querySelector(".user-dropdown-container");

  if (!container) {
    console.error("找不到 .user-dropdown-container");
    return;
  }

  // 切換 active 類別（打開 / 關閉選單）
  container.classList.toggle("active");
}


// 點擊其他地方時關閉下拉選單
document.addEventListener("click", (event) => {
  const container = document.querySelector(".user-dropdown-container");

  if (!container) return;

  if (!container.contains(event.target)) {
    container.classList.remove("active");
  }
});


// ==================== 👤 編輯使用者 ====================

// 1. 打開「編輯個人資料」彈窗並自動填入原本的資料
function openEditUserModal() {
  // 關閉右上角的使用者選單
  const dropdown = document.querySelector('.user-dropdown-container');
  if (dropdown) dropdown.classList.remove('active');

  // 從瀏覽器快取 (localStorage) 讀取目前登入的使用者資料
  const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
  
  if (currentUser) {
    // 取得 HTML 裡的各個輸入框
    const displayName = document.getElementById('editUserDisplayName');
    const nickname = document.getElementById('editUserNickname');
    const username = document.getElementById('editUserUsername');
    const phone = document.getElementById('editUserPhone');

    // 把資料自動帶入輸入框
    if (displayName) displayName.textContent = currentUser.nickname || currentUser.username || '使用者';
    if (nickname) nickname.value = currentUser.nickname || '';
    if (username) username.value = currentUser.username || '';
    if (phone) phone.value = currentUser.phone || '';
  }

  // 將彈窗顯示出來 (display: flex)
  const modal = document.getElementById('editUserModal');
  if (modal) modal.style.display = 'flex';
}

// 2. 關閉「編輯個人資料」彈窗
function closeEditUserModal() {
  const modal = document.getElementById('editUserModal');
  if (modal) modal.style.display = 'none';
}

// 登出處理
function handleLogout() {
  const username = localStorage.getItem("username");
  if (confirm(`目前帳號：${username || "使用者"}\n確定要登出嗎？`)) {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("nickname");
    alert("已成功登出");
    window.location.reload();
  }
}

// 登入 API
async function login() {
  const btn = document.getElementById("loginBtn");
  const usernameInput = document.getElementById("loginUsername");
  const passwordInput = document.getElementById("loginPassword");

  if (!usernameInput || !passwordInput) return;

  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();

  if (!username || !password) {
    alert("請輸入帳號密碼");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "登入中...";
  }

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (data.ok) {
  localStorage.setItem("token", data.token);
  localStorage.setItem("username", data.username);
  localStorage.setItem("nickname", data.nickname || "");

  alert("登入成功！");
  closeModals();
  setupUserIcon();

  if (typeof loadFavorites === "function") {
    loadFavorites().then(() => {
      if (typeof render === "function") render();
    });
  }
} else {
      alert(data.error || "登入失敗");
    }
  } catch (err) {
    console.error(err);
    alert("連線發生問題，請稍後再試");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "登入";
    }
  }
}

// 支援 Enter 鍵快捷送出 (登入)
const loginPasswordInput = document.getElementById('loginPassword');
if (loginPasswordInput) {
  loginPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && loginModal && loginModal.style.display === 'flex') {
      login();
    }
  });
}

// 支援 Enter 鍵快捷送出 (註冊)
const regPasswordInput = document.getElementById('reg-password');
if (regPasswordInput) {
  regPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && registerModal && registerModal.style.display === 'flex') {
      submitRegister(); // 直接呼叫註冊邏輯
    }
  });
}

// ==================== AI 收藏庫功能 (取代舊的歷史紀錄按鈕) ====================
// ==================== 🎯 開啟 AI 收藏庫 Modal (原生 Top Layer 頂層) ====================
function openAiFavoritesModal() {
  const token = getToken();
  if (!token) {
    alert("請先登入才能查看收藏庫喔！");
    if (typeof switchToLogin === "function") switchToLogin();
    return;
  }

  const aiHistoryModal = document.getElementById("aiHistoryModal");
  if (!aiHistoryModal) {
    console.error("找不到 #aiHistoryModal 元素");
    return;
  }

  // 1. 確保搬至 body 最外層 (擺脫所有對話框視窗的容器限制)
  if (aiHistoryModal.parentNode !== document.body) {
    document.body.appendChild(aiHistoryModal);
  }

  // 2. 呼叫瀏覽器原生 showModal()，直接送入 Top Layer 最頂層
  if (typeof aiHistoryModal.showModal === "function") {
    try {
      if (!aiHistoryModal.open) {
        aiHistoryModal.showModal();
      }
    } catch (e) {
      aiHistoryModal.style.display = "flex";
    }
  } else {
    aiHistoryModal.style.display = "flex";
  }

  // 3. 載入收藏內容
  if (typeof loadAiHistories === "function") {
    loadAiHistories("favorites");
  }
}

// ==================== 🎯 關閉 AI 收藏庫 Modal (徹底解除畫面鎖定) ====================
function closeAiFavoritesModal() {
  const aiHistoryModal = document.getElementById("aiHistoryModal");
  if (aiHistoryModal) {
    // 1. 原生 Dialog 關閉
    if (typeof aiHistoryModal.close === "function" && aiHistoryModal.open) {
      aiHistoryModal.close();
    }
    // 2. 備用 CSS 隱藏
    aiHistoryModal.style.display = "none";
  }

  // 3. 🎯 關鍵修復：強制把 pointer-events 與 overflow 復原，徹底解決畫面卡死問題
  document.body.style.pointerEvents = "auto";
  document.body.style.overflow = "auto";
}

// ==================== AI 歷史紀錄與收藏功能 ====================
let currentConversationIsFavorite = false; // 追蹤目前聊天室的收藏狀態

let currentHistoryFilter = 'all'; // 追蹤目前歷史紀錄停留在哪個分頁 ('all' 或 'favorites')

// 1. 同步切換星星狀態的核心函數 (更新：支援獨立星星元件即時變色)
// 1. 同步切換星星狀態的核心函數 (更新：支援獨立星星元件即時變色)
async function toggleAiFavorite(convId, currentStatus, btnElement = null) {
  const token = getToken();
  
  // 🛡️ 新增未登入的防呆與引導機制
  if (!token) {
    alert("請先登入才能將對話加入收藏庫喔！");
    switchToLogin(); // 自動打開登入浮動視窗
    return;
  }

  const newStatus = !currentStatus;
  try {
    const res = await fetch(`/api/ai/conversations/${convId}/favorite`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ is_favorite: newStatus })
    });
    
    const data = await res.json();
    if (data.ok) {
      // 🌟 如果有傳入按鈕元素，直接讓那顆星星變色，不用重新整理整個畫面
      if (btnElement) {
        btnElement.style.color = newStatus ? '#ffc107' : '#ccc';
        btnElement.innerText = newStatus ? '⭐' : '☆';
        // 更新 onclick 事件，把最新的狀態綁定上去
        btnElement.setAttribute('onclick', `toggleAiFavorite(${convId}, ${newStatus}, this)`);
      }
      
      // 如果歷史紀錄視窗開著，傳入目前的分頁狀態來重新載入以維持同步
      if (document.getElementById('aiHistoryModal')?.style.display === 'flex') {
        loadAiHistories(currentHistoryFilter);
      }
    }
  } catch (err) {
    console.error("切換星星失敗", err);
  }
}

// 2. 綁定當前聊天室的星星點擊事件
document.getElementById('aiActiveStarBtn')?.addEventListener('click', () => {
  if (currentConversationId) {
    toggleAiFavorite(currentConversationId, currentConversationIsFavorite);
  }
});

// 3. 載入對話清單 (更新：加入分頁切換與對話預覽UI)
async function loadAiHistories(filter = 'all') {
  currentHistoryFilter = filter; // 更新目前的分頁狀態
  const token = getToken();
  
  if (!token) {
    alert("請先登入才能查看收藏庫與歷史紀錄喔！");
    
    const modal = document.getElementById("aiHistoryModal");
    if (modal) modal.style.display = 'none';
    
    switchToLogin();
    return;
  }

  const listContainer = document.getElementById("aiHistoryList");
  if (!listContainer) return;

  listContainer.innerHTML = '<p style="color: #888; text-align: center;">讀取紀錄中...</p>';
  try {
    const res = await fetch("/api/ai/conversations", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.ok) {
      let conversations = data.data;

      // 根據時間排序所有的歷史紀錄 (無上限保留)
      conversations = conversations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      // 根據目前點擊的分頁來過濾要顯示的清單
      const displayConvs = currentHistoryFilter === 'favorites' 
        ? conversations.filter(c => c.is_favorite) 
        : conversations;

      // 建立上方的分頁按鈕與清除按鈕
      let htmlContent = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
          <div style="display: flex; gap: 8px;">
            <button onclick="loadAiHistories('all')" style="border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; background: ${currentHistoryFilter === 'all' ? '#ff5722' : '#f0f0f0'}; color: ${currentHistoryFilter === 'all' ? '#fff' : '#555'}; font-weight: bold; transition: 0.2s;">
              全部紀錄
            </button>
            <button onclick="loadAiHistories('favorites')" style="border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; background: ${currentHistoryFilter === 'favorites' ? '#ffc107' : '#f0f0f0'}; color: ${currentHistoryFilter === 'favorites' ? '#fff' : '#555'}; font-weight: bold; transition: 0.2s;">
              ⭐ 收藏庫
            </button>
          </div>
          <button onclick="clearAllAiHistory()" style="background: #ff5252; color: #fff; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: 0.2s;">
            🗑️ 清除紀錄
          </button>
        </div>
      `;

      if (displayConvs.length === 0) {
        htmlContent += `<p style="color: #888; text-align: center; margin-top: 30px;">尚無${currentHistoryFilter === 'favorites' ? '收藏' : '對話'}紀錄</p>`;
        listContainer.innerHTML = htmlContent;
        return;
      }

      // 產生對話預覽卡片
      for (const conv of displayConvs) {
        const starColor = conv.is_favorite ? '#ffc107' : '#ccc';
        const starIcon = conv.is_favorite ? '⭐' : '☆';
        
        let aiPreviewText = (conv.ai_reply || "無回應").replace(/<<<SEARCH:(.*?)>>>/, "").trim();
        if (aiPreviewText.length > 35) aiPreviewText = aiPreviewText.substring(0, 35) + "...";

        let convHtml = `
          <div style="width: 100%; box-sizing: border-box; text-align: left; padding: 12px; margin-bottom: 12px; border: 1px solid #eaeaea; border-radius: 10px; background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.03); cursor: pointer; transition: transform 0.1s;" onclick="loadSingleConversation(${conv.id}, ${conv.is_favorite})" onmouseover="this.style.transform='scale(1.01)'" onmouseout="this.style.transform='scale(1)'">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
              <strong style="color: #333; font-size: 0.95rem; line-height: 1.4; flex: 1;">🧑 你：${escapeHtml(conv.title)}</strong>
              <button onclick="event.stopPropagation(); toggleAiFavorite(${conv.id}, ${conv.is_favorite})" style="background:none; border:none; font-size: 1.3rem; color: ${starColor}; cursor: pointer; margin-left: 10px;" title="加入/取消收藏">${starIcon}</button>
            </div>
            <div style="background: #f9f9f9; padding: 8px 10px; border-radius: 6px; border-left: 3px solid #ff5722;">
              <p style="margin: 0; color: #666; font-size: 0.85rem; line-height: 1.4;">🤖 AI：${escapeHtml(aiPreviewText)}</p>
            </div>
          </div>
        `;
        htmlContent += convHtml;
      }
      listContainer.innerHTML = htmlContent;
    }
  } catch (err) {
    console.error("載入歷史紀錄失敗", err);
    listContainer.innerHTML = '<p style="color: red; text-align: center;">載入失敗</p>';
  }
}

// 4. 清除所有 AI 對話紀錄 (只刪除一般對話，並將畫面留白隱藏收藏)
async function clearAllAiHistory() {
  const confirmDelete = confirm("確定要清除未收藏的歷史對話嗎？");
  if (!confirmDelete) return;

  const token = getToken();
  if (!token) return;
  const btn = event.target;
  const originalText = btn.innerHTML;
  btn.innerHTML = "清除中...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/ai/conversations", { headers: { Authorization: `Bearer ${token}` }});
    const data = await res.json();
    
    if (data.ok && data.data) {
      // 只挑出未收藏 (is_favorite 為 false) 的紀錄發送刪除請求
      const unfavorite = data.data.filter(c => !c.is_favorite);
      const deletePromises = unfavorite.map(conv => 
        fetch(`/api/ai/conversations/${conv.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        })
      );
      await Promise.all(deletePromises);
    }

    // 達到你要求的「畫面留白隱藏」，不重新呼叫 loadAiHistories()
    document.getElementById("aiHistoryList").innerHTML = '<p style="color: #888; text-align: center; margin-top: 20px;">已清空一般紀錄。<br><span style="font-size: 0.85rem;">(已收藏紀錄安穩保留於系統後台中)</span></p>';
    
    // 如果當前正在聊的視窗沒被收藏，也一併重置聊天室畫面
    if (!currentConversationIsFavorite) {
      document.getElementById('aiOutput').innerHTML = '';
      currentConversationId = null;
      aiHistoryMessages = [];
      lastRecommendedNames = [];
      activeMenuRestaurantName = "";
      lastFocusedNames = [];
      rejectedRestaurantNames = [];
      const activeStarBtn = document.getElementById('aiActiveStarBtn');
      if (activeStarBtn) activeStarBtn.style.display = 'none';
    }

  } catch (err) {
    console.error("清除紀錄失敗", err);
    alert("清除紀錄失敗，請稍後再試。");
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

// 5. 載入單一對話的詳細內容 (加入頂部星星狀態顯示與餐廳卡片渲染)
async function loadSingleConversation(id, isFavorite = false) {
  const token = getToken();
  const aiOutput = document.getElementById("aiOutput");
  if (!token) return;

  try {
    const res = await fetch(`/api/ai/conversations/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.ok) {
      currentConversationId = id;
      currentConversationIsFavorite = isFavorite;

      
      // ===== 恢復 AI 歷史對話記憶 =====

      const messages = data.data ||
                       data.messages ||
                       data.conversation || [];

      aiHistoryMessages = messages
        .filter(msg =>
          msg.role === "user" ||
          msg.role === "assistant"
        )
        .map(msg => ({
          role: msg.role,
          content: msg.content ||
                   msg.user_message ||
                   msg.ai_reply || ""
        }))
        .filter(msg => msg.content)
        .slice(-20);

      // ===== 恢復上一輪推薦的餐廳 =====

      lastRecommendedNames = [];
      activeMenuRestaurantName = "";
      lastFocusedNames = [];
      rejectedRestaurantNames = [];

      // 依對話順序恢復被拒絕的餐廳（被拒絕前最近一次顯示的店家）。
      let priorFocused = [];
      for (const msg of messages) {
        const content = msg.content || msg.ai_reply || "";
        if (msg.role === "user" &&
            /(不想吃|不要這間|不要那間|不考慮這間|不考慮那間|排除這間|排除那間)/.test(content)) {
          rejectedRestaurantNames = [...new Set([...rejectedRestaurantNames, ...priorFocused])];
        }
        if (msg.role === "assistant") {
          const m = content.match(/<<<SEARCH:([^>]*)>>>/);
          if (m && m[1].trim()) priorFocused = m[1].split("|").map(x => x.trim()).filter(Boolean);
        }
      }

      for (const msg of [...messages].reverse()) {
        if (msg.role !== "assistant") continue;

        const content = msg.content ||
                        msg.ai_reply || "";

        const match = content.match(
          /<<<SEARCH:([^>]*)>>>/
        );

        if (match && match[1].trim()) {
          const names = match[1].split("|").map(name => name.trim()).filter(Boolean);
          if (!lastFocusedNames.length) lastFocusedNames = [...names];
          if (names.length > 1) {
            lastRecommendedNames = names;
            break;
          }
          if (!lastRecommendedNames.length) lastRecommendedNames = names;
        }
      }

      console.log("恢復歷史記憶：", aiHistoryMessages);
      console.log("恢復推薦餐廳：", lastRecommendedNames);


      // 🎯 1. 點擊瞬間立即徹底關閉 Modal，防止遮罩擋住螢幕
      closeAiFavoritesModal();

      const aiChat = document.getElementById("aiChat");
      if (aiChat) aiChat.style.display = "block";

      // 頂部星星變色
      const topStar = document.getElementById("aiActiveStarBtn");
      if (topStar) {
        topStar.style.display = "inline-block";
        topStar.style.color = isFavorite ? "#ffc107" : "#ccc";
        topStar.innerText = isFavorite ? "⭐" : "☆";
      }

      if (aiOutput) {
        aiOutput.innerHTML = "";

        messages.forEach(msg => {
          if (msg.role === "user") {
            aiOutput.innerHTML += `
              <div class="ai-msg user-msg" style="margin-bottom: 12px;">
                <strong>🧑 你：</strong> ${escapeHtml(msg.content || msg.user_message || "")}
              </div>
            `;
          } else {
            // 清理標籤文字
            let cleanText = (msg.content || msg.ai_reply || "").replace(/<<<SEARCH:(.*?)>>>/, "").trim();

            // 🎯 2. 多重相容解析：支援所有可能的餐廳資料欄位名稱 (restaurants / recommendations / items)
            let restaurants = msg.restaurants || msg.recommendations || msg.items || [];
            
            // 如果後端將餐廳 JSON 存成字串，嘗試解析
            if (typeof restaurants === "string") {
              try { restaurants = JSON.parse(restaurants); } catch (e) { restaurants = []; }
            }

            // 如果該次對話內沒有帶餐廳，嘗試從文字內提取或檢查單筆頂層資料
            if (!Array.isArray(restaurants) || restaurants.length === 0) {
              if (data.restaurants) restaurants = data.restaurants;
            }

            // 渲染餐廳卡片 HTML
            let restaurantsHtml = "";
            if (Array.isArray(restaurants) && restaurants.length > 0) {
              restaurantsHtml = `
                <div class="ai-restaurant-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
                  ${restaurants.map(r => `
                    <div class="ai-restaurant-card" onclick="window.location.href='detail.html?id=${r.id || r.restaurant_id}'" style="display: flex; align-items: center; gap: 10px; padding: 10px; background: #fff; border-radius: 10px; border: 1px solid #e0e0e0; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                      <img src="${r.image_url || r.image || 'images/default-restaurant.jpg'}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 6px;" alt="${escapeHtml(r.name || '餐廳')}">
                      <div style="flex: 1; text-align: left;">
                        <div style="font-weight: bold; color: #333; font-size: 0.9rem;">${escapeHtml(r.name || r.restaurant_name || '推薦餐廳')}</div>
                        <div style="font-size: 0.75rem; color: #ff9800;">⭐ ${r.rating || '4.5'} (${r.review_count || 100}人評分)</div>
                        <div style="font-size: 0.75rem; color: #666;">💰 ${r.price_range || r.price || 'NT$100~200'}</div>
                      </div>
                    </div>
                  `).join("")}
                </div>
              `;
            }

            aiOutput.innerHTML += `
              <div class="ai-msg bot-msg" style="margin-bottom: 12px;">
                <strong>🤖 AI：</strong> ${escapeHtml(cleanText)}
                ${restaurantsHtml}
              </div>
              <hr style="border: none; border-top: 1px solid #eee; margin: 12px 0;">
            `;
          }
        });
      }

      // 自動捲動到底部
      const outputContainer = document.getElementById("aiOutput");
      if (outputContainer) {
        outputContainer.scrollTop = outputContainer.scrollHeight;
      }
    }
  } catch (err) {
    console.error("讀取對話失敗", err);
    closeAiFavoritesModal(); // 發生錯誤也強制解鎖
  }
}


// 打開彈出視窗並動態渲染餐廳詳情
function openRestaurantDetail(storeId) {
  const modal = document.getElementById("restaurantModal");
  const modalBody = document.getElementById("modalBody");

  if (!modal || !modalBody) return;

  modal.style.display = "flex";
  modalBody.innerHTML = `<h3>🔍 資料載入中...</h3>`;

  fetch(`/api/restaurants/${storeId}`)
    .then((res) => res.json())
    .then((result) => {
      if (!result.ok || !result.data) {
        modalBody.innerHTML = `<h3>❌ 找不到該餐廳資料</h3>`;
        return;
      }

      const store = result.data; 
      
      let img = store.image_url;
      if (!img && store.photos && store.photos.length > 0) {
        img = store.photos[0].image_url;
      }
      if (!img) {
        img = "https://via.placeholder.com/220x150?text=No+Photo";
      }
      
      modalBody.innerHTML = `
        <img src="${img}" style="width: 100%; max-height: 250px; object-fit: cover; border-radius: 12px; margin-bottom: 15px;">
        <h2 style="color: #ff5722; margin: 0 0 10px 0;">${store.name || "(未命名)"}</h2>
        <div style="text-align: left; line-height: 1.6; color: #444;">
          ${store.address ? `<p>📍 <strong>地址：</strong>${store.address}</p>` : ""}
          ${store.phone ? `<p>📞 <strong>電話：</strong>${store.phone}</p>` : "<p>📞 <strong>電話：</strong>暫無資料</p>"}
          ${store.rating != null ? `<p>⭐ <strong>評分：</strong>${store.rating} (${store.user_ratings_total || 0}人評分)</p>` : ""}
        </div>
      `;
    })
    .catch((err) => {
      console.error("無法取得餐廳詳情：", err);
      modalBody.innerHTML = `<h3>❌ 無法載入餐廳詳情，請稍後再試</h3>`;
    });
}

// 關閉彈出視窗
function closeModal() {
  const modal = document.getElementById("restaurantModal");
  if (modal) {
    modal.style.display = "none";
  }
}


// === 處理懸浮視窗的註冊送出（包含 8 位數字與 4-10位英數字限制） ===
// ============================================================
// 註冊會員
// 帳號 + 暱稱 + 密碼
// ============================================================
async function submitRegister() {
  const btn = document.getElementById("regBtn");
  const usernameInput = document.getElementById("reg-username");
  const nicknameInput = document.getElementById("reg-nickname");
  const passwordInput = document.getElementById("reg-password");
  const phoneInput = document.getElementById("reg-phone"); // ✨ 新增取得元素

  if (!usernameInput || !nicknameInput || !passwordInput || !phoneInput) {
    alert("找不到註冊欄位，請重新整理頁面");
    return;
  }

  const username = usernameInput.value.trim();
  const nickname = nicknameInput.value.trim();
  const password = passwordInput.value.trim();
  const phone = phoneInput.value.trim(); // ✨ 取得手機號碼

  const usernameHint = document.getElementById("regUsernameHint");
  const nicknameHint = document.getElementById("regNicknameHint");
  const passwordHint = document.getElementById("regPasswordHint");
  const phoneHint = document.getElementById("regPhoneHint");


  // ==========================================================
  // 重設提示文字
  // ==========================================================

  if (usernameHint) {
    usernameHint.style.color = "#888";
    usernameHint.style.fontWeight = "normal";
    usernameHint.textContent =
      "必須為 8 個純數字";
  }

  if (nicknameHint) {
    nicknameHint.style.color = "#888";
    nicknameHint.style.fontWeight = "normal";
    nicknameHint.textContent =
      "將顯示於好友動態";
  }

  if (passwordHint) {
    passwordHint.style.color = "#888";
    passwordHint.style.fontWeight = "normal";
    passwordHint.textContent =
      "必須為 4~10 個英數字";
  }


  // ==========================================================
  // 驗證帳號
  // ==========================================================

  if (!username) {
    if (usernameHint) {
      usernameHint.textContent =
        "❌ 請輸入帳號";

      usernameHint.style.color =
        "#ff3333";

      usernameHint.style.fontWeight =
        "bold";
    }

    return;
  }


  const usernameRegex =
    /^[0-9]{8}$/;


  if (!usernameRegex.test(username)) {
    if (usernameHint) {
      usernameHint.textContent =
        "❌ 帳號必須為 8 個純數字";

      usernameHint.style.color =
        "#ff3333";

      usernameHint.style.fontWeight =
        "bold";
    }

    return;
  }


  // ==========================================================
  // 驗證暱稱
  // ==========================================================

  if (!nickname) {
    if (nicknameHint) {
      nicknameHint.textContent =
        "❌ 請輸入社群暱稱";

      nicknameHint.style.color =
        "#ff3333";

      nicknameHint.style.fontWeight =
        "bold";
    }

    return;
  }


  if (
    nickname.length < 1 ||
    nickname.length > 20
  ) {
    if (nicknameHint) {
      nicknameHint.textContent =
        "❌ 暱稱必須為 1～20 個字";

      nicknameHint.style.color =
        "#ff3333";

      nicknameHint.style.fontWeight =
        "bold";
    }

    return;
  }


  // ==========================================================
  // 驗證密碼
  // ==========================================================

  if (!password) {
    if (passwordHint) {
      passwordHint.textContent =
        "❌ 請輸入密碼";

      passwordHint.style.color =
        "#ff3333";

      passwordHint.style.fontWeight =
        "bold";
    }

    return;
  }


  const passwordRegex =
    /^[a-zA-Z0-9]{4,10}$/;


  if (!passwordRegex.test(password)) {
    if (passwordHint) {
      passwordHint.textContent =
        "❌ 密碼必須為 4~10 個英數字";

      passwordHint.style.color =
        "#ff3333";

      passwordHint.style.fontWeight =
        "bold";
    }

    return;
  }

  // ==========================================================
  // ✨ 驗證手機號碼 (新增這段)
  // ==========================================================
  if (phoneHint) {
    phoneHint.style.color = "#888";
    phoneHint.style.fontWeight = "normal";
    phoneHint.textContent = "忘記密碼時用來驗證身份";
  }

  if (!phone) {
    if (phoneHint) {
      phoneHint.textContent = "❌ 請輸入手機號碼";
      phoneHint.style.color = "#ff3333";
      phoneHint.style.fontWeight = "bold";
    }
    return;
  }

  const phoneRegex = /^09\d{8}$/; // 驗證台灣手機號碼格式 (09開頭，共10碼)
  if (!phoneRegex.test(phone)) {
    if (phoneHint) {
      phoneHint.textContent = "❌ 手機號碼格式錯誤";
      phoneHint.style.color = "#ff3333";
      phoneHint.style.fontWeight = "bold";
    }
    return;
  }

  // ==========================================================
  // 發送註冊 (修改 body)
  // ==========================================================
  if (btn) {
    btn.disabled = true;
    btn.textContent = "註冊中...";
  }

  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        nickname,
        password,
        phone // ✨ 把手機號碼一起送到後端
      })
    });


    const data =
      await res.json();


    if (res.ok && data.ok) {

      alert(
        "🎉 註冊成功！請登入"
      );


      // 清空欄位
      usernameInput.value = "";
      nicknameInput.value = "";
      passwordInput.value = "";


      // 回登入頁
      switchToLogin();

    } else {

      const errorMessage =
        data.error ||
        "註冊失敗";


      alert(
        "❌ " + errorMessage
      );


      if (usernameHint) {
        usernameHint.textContent =
          "❌ " + errorMessage;

        usernameHint.style.color =
          "#ff3333";

        usernameHint.style.fontWeight =
          "bold";
      }
    }


  } catch (err) {

    console.error(
      "註冊 API 錯誤：",
      err
    );


    alert(
      "❌ 系統連線失敗"
    );


  } finally {

    if (btn) {
      btn.disabled = false;
      btn.textContent = "註冊";
    }
  }
}

// === 處理懸浮視窗的登入送出 ===
async function submitLogin() {
  login(); // 為了相容性，這裡直接呼叫已經寫好的 login()
}

// ==================== 備忘錄懸浮視窗功能 ====================

// 打開備忘錄視窗並去後端撈取舊有筆記
async function openNoteModal(storeId, storeName) {
  const modal = document.getElementById("noteModal");
  const noteStoreName = document.getElementById("noteStoreName");
  const currentNoteStoreId = document.getElementById("currentNoteStoreId");
  const noteTextArea = document.getElementById("noteTextArea");

  if (!modal || !noteStoreName || !currentNoteStoreId || !noteTextArea) return;

  noteStoreName.textContent = storeName || "這家餐廳";
  currentNoteStoreId.value = storeId;
  noteTextArea.value = "載入筆記中...";
  modal.style.display = "flex";

  try {
    const token = localStorage.getItem("token");
    
    // 🎯 修正 1：修改成與後端 server.js 完美對接的備忘錄 API 網址！
    const res = await fetch(`/api/restaurants/${storeId}/memo`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    const data = await res.json();
    
    // 🎯 修正 2：後端回傳的格式是 { ok: true, content: "..." }
    if (res.ok && data.ok) {
      noteTextArea.value = data.content || ""; // 填入原本存過的字，沒存過就給空字串
    } else {
      noteTextArea.value = "";
    }
  } catch (err) {
    console.error("無法撈取備忘錄：", err);
    noteTextArea.value = "載入失敗，請重新嘗試";
  }
}

// 關閉備忘錄視窗
function closeNoteModal() {
  const modal = document.getElementById("noteModal");
  if(modal) modal.style.display = "none";
}

// 點擊「儲存文字」將內容發給後端
async function submitStoreNote() {
  const storeIdInput = document.getElementById("currentNoteStoreId");
  const noteTextArea = document.getElementById("noteTextArea");
  if (!storeIdInput || !noteTextArea) return;

  const storeId = storeIdInput.value;
  const noteText = noteTextArea.value.trim();
  const token = localStorage.getItem("token");

  try {
    // 🎯 修正 1 & 2：將網址改為對齊後端，且 Method 改為 "PUT"
    const res = await fetch(`/api/restaurants/${storeId}/memo`, {
      method: "PUT", 
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      // 🎯 修正 3：欄位名稱必須改為 "content"，後端才認得喔！
      body: JSON.stringify({ content: noteText }) 
    });
    
    const data = await res.json();

    if (res.ok && data.ok) {
      alert("🎉 備忘錄儲存成功！");
      closeNoteModal();
    } else {
      alert("❌ 儲存失敗：" + (data.error || "未知錯誤"));
    }
  } catch (err) {
    console.error("儲存備忘錄出錯：", err);
    alert("系統連線失敗，請稍後再試");
  }
}


function toggleMoreTags() {
  const moreTags = document.querySelectorAll('.more-tag');
  const moreBtn = document.getElementById('moreBtn');

  moreTags.forEach(tag => {
    tag.classList.toggle('hidden-tag');
  });

  if (moreBtn) {
    if (moreBtn.innerText.includes('更多')) {
      moreBtn.innerText = '➖ 收起';
    } else {
      moreBtn.innerText = '➕ 更多';
    }
  }
}

function scrollCategories(distance) {
  const container = document.getElementById('categoryContainer');
  if (container) {
    container.scrollBy({
      left: distance
    });
  }
}

// ==================== 歡迎視窗控制功能 ====================
function closeWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if(modal) modal.style.display = "none";
  localStorage.setItem("hasSeenWelcome", "true");
  console.log("🔒 已記錄：使用者看過歡迎視窗 (hasSeenWelcome = true)");
}

// 🎯 緊接在後面：處理自動彈出與問號 Icon 點擊
document.addEventListener("DOMContentLoaded", () => {
  const welcomeModal = document.getElementById("welcomeModal");
  const hasSeenWelcome = localStorage.getItem("hasSeenWelcome");
  
  // 1. 檢查快取：只有沒看過（!hasSeenWelcome）時才自動顯示
  if (welcomeModal) {
    if (!hasSeenWelcome) {
      welcomeModal.style.display = "flex";
    } else {
      welcomeModal.style.display = "none"; // 強制隱藏
    }
  }

  // 2. 點擊問號 Icon 手動打開
  const helpIcon = document.getElementById("helpIcon");
  if (helpIcon && welcomeModal) {
    helpIcon.addEventListener("click", (e) => {
      e.preventDefault();
      welcomeModal.style.display = "flex";
    });
  }

  // 🎯 3. 雙重保險：直接幫「開始探索」按鈕綁定點擊事件
  if (welcomeModal) {
    const startBtn = welcomeModal.querySelector("button");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        closeWelcomeModal();
      });
    }
  }
});

// ==================== 好友 Modal 控制邏輯 ====================

// 統一產生登入驗證 Header
function getAuthHeaders(includeJson = false) {
  const token = getToken();

  const headers = {};

  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}


// ============================================================
// 🔒 全域 API Fetch 包裝 (自動處理 401/403 逾時登出與跳轉登入)
// ============================================================
async function apiFetch(url, options = {}) {
  const defaultHeaders = typeof getAuthHeaders === 'function' ? getAuthHeaders() : {};
  options.headers = {
    ...defaultHeaders,
    ...(options.headers || {})
  };

  try {
    const res = await fetch(url, options);

    // 當後端回傳 401 (Token 過期) 或 403 (未授權)
    if (res.status === 401 || res.status === 403) {
      console.warn("登入已逾時，自動清除登入資訊並跳轉至登入畫面");

      // 1. 自動登出：清除本地 Token 與使用者資訊
      if (typeof logout === 'function') {
        logout(false);
      } else {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      }

      // 2. 提示使用者
      alert("登入已逾時，請重新登入！");

      // 3. 自動導向登入視窗
      if (typeof switchToLogin === 'function') {
        switchToLogin();
      } else if (typeof openLoginModal === 'function') {
        openLoginModal();
      } else {
        window.location.reload();
      }

      throw new Error("登入逾時，請重新登入");
    }

    return res;
  } catch (err) {
    throw err;
  }
}

// 開啟好友視窗
function openFriendsModal() {
  const token = getToken();

  if (!token) {
    alert("請先登入才能查看好友功能喔！");
    if (typeof switchToLogin === "function") switchToLogin();
    return;
  }

  // 關閉下拉選單
  const container = document.querySelector(".user-dropdown-container");
  if (container) {
    container.classList.remove("active");
  }

  const friendsModal = document.getElementById("friendsModal");
  if (friendsModal) {
    // 🎯 關鍵修復：確保好友 Modal 移至 <body> 最底端，避免受父容器 z-index / Stacking Context 限制
    if (friendsModal.parentNode !== document.body) {
      document.body.appendChild(friendsModal);
    }
    
    // 強制設定最高的 z-index
    friendsModal.style.setProperty("z-index", "99999", "important");
    friendsModal.style.display = "flex";
  }

  if (typeof openUserPanel === "function") {
    openUserPanel("friends");
  }
}

// 關閉好友視窗
function closeFriendsModal() {
  const modal = document.getElementById("friendsModal");
  if (!modal) return;

  modal.style.display = "none";
  document.body.classList.remove("modal-open"); // 移除鎖定 Class

  const feedContainer = document.getElementById("friendFeedList");
  if (feedContainer) {
    feedContainer.innerHTML = "";
  }
}

// ==================== 3. 切換好友頁籤 ====================
function switchFriendTab(tabName) {
  const tabs = document.querySelectorAll(
    ".friends-tabs .tab-btn"
  );

  const contents = document.querySelectorAll(
    ".friends-modal-body .tab-content"
  );

  tabs.forEach(tab => {
    tab.classList.remove("active");
  });

  contents.forEach(content => {
    content.classList.remove("active");
  });

  const targetContent =
    document.getElementById(`tab-${tabName}`);

  if (targetContent) {
    targetContent.classList.add("active");
  }

  const targetTab =
    document.querySelector(
      `.tab-btn[onclick*="'${tabName}'"]`
    );

  if (targetTab) {
    targetTab.classList.add("active");
  }

  // 根據分頁讀取資料
  if (tabName === "feed") {

  loadFriendFeeds();

  loadFeedFriendAvatars();
}

  if (tabName === "list") {
    loadMyFriends();
  }

  if (tabName === "requests") {
    loadFriendRequests();
  }
}


// ==================== 4. 好友動態 ====================
// ============================================================
// 👥 載入好友動態上方頭像
// ============================================================


// ============================================================
// 🎯 貼文卡片渲染函式
// ============================================================
// 🎯 通用貼文卡片 HTML 生成器 (含安全 ID 解析)
// ============================================================
function renderPostCardHtml(post, nicknameOverride = null) {
  const displayName =
    nicknameOverride ||
    post.nickname ||
    post.username ||
    "使用者";

  const avatarText = displayName.charAt(0).toUpperCase();

  const timeText = post.created_at
    ? new Date(post.created_at).toLocaleString("zh-TW")
    : "";

  // 🎯 安全取得目前登入者的 ID (優先從全域函式/變數/Token/localStorage 取得)
  let currentUserId = null;
  if (typeof getCurrentUserId === "function") {
    currentUserId = getCurrentUserId();
  } else if (typeof getUserId === "function") {
    currentUserId = getUserId();
  } else if (typeof currentUser !== "undefined" && currentUser?.id) {
    currentUserId = currentUser.id;
  } else {
    // 備用方案：直接從 localStorage 或 JWT 解析
    try {
      const userStr = localStorage.getItem("user");
      if (userStr) {
        const userObj = JSON.parse(userStr);
        currentUserId = userObj.id || userObj.userId || userObj.user_id;
      }
    } catch (e) {
      currentUserId = null;
    }
  }

  // 🎯 判斷是否為貼文擁有者 (優先看後端 post.is_owner，沒有則比對 ID)
  const isOwner =
    post.is_owner ||
    (currentUserId && Number(currentUserId) === Number(post.user_id));

  // 1. 安全解析圖片陣列
  let imagesList = post.images;
  if (typeof imagesList === "string") {
    try { imagesList = JSON.parse(imagesList); } catch (e) { imagesList = []; }
  }
  if (!Array.isArray(imagesList)) {
    imagesList = post.image_url ? [post.image_url] : [];
  }

  return `
    <div class="feed-card" id="post-${post.post_id || post.id}">

      <!-- 1. 頭貼 + 名稱 + 刪除按鈕 -->
      <div class="feed-header">
        <div class="feed-avatar">
          ${escapeHtml(avatarText)}
        </div>

        <div class="feed-user-info">
          <div class="feed-author">
            ${escapeHtml(displayName)}
          </div>
        </div>

        ${
          isOwner
            ? `
              <button
                type="button"
                class="post-delete-btn"
                onclick="deletePost(${post.post_id || post.id})"
                title="刪除貼文"
              >
                🗑️
              </button>
            `
            : ""
        }
      </div>

      <!-- 2. 貼文內容主體 -->
      <div class="feed-body">

        <!-- 文字 -->
        ${
          post.content
            ? `
              <p class="feed-caption">
                ${escapeHtml(post.content)}
              </p>
            `
            : ""
        }

        <!-- 🖼️ 照片輪播區 -->
        ${
          imagesList.length > 0
            ? `
              <div class="feed-carousel">
                <div
                  class="feed-carousel-track"
                  onscroll="updateCarouselDots(this)"
                >
                  ${imagesList.map((imageUrl, index) => `
                    <div class="feed-carousel-slide">
                      <img
                        src="${imageUrl}"
                        class="feed-carousel-image"
                        alt="貼文照片 ${index + 1}"
                        loading="lazy"
                        onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'220\' height=\'150\' viewBox=\'0 0 220 150\'><rect width=\'100%\' height=\'100%\' fill=\'%23f0f0f0\'/><text x=\'50%\' y=\'50%\' dominant-baseline=\'middle\' text-anchor=\'middle\' font-family=\'sans-serif\' font-size=\'16\' fill=\'%23999999\'>無照片</text></svg>'"
                      >
                    </div>
                  `).join("")}
                </div>

                ${
                  imagesList.length > 1
                    ? `
                      <div class="feed-carousel-count">
                        1 / ${imagesList.length}
                      </div>
                      <div class="feed-carousel-dots">
                        ${imagesList.map((_, index) => `
                          <span class="feed-carousel-dot ${index === 0 ? "active" : ""}"></span>
                        `).join("")}
                      </div>
                    `
                    : ""
                }
              </div>
            `
            : ""
        }

        <!-- 📍 橘色醒目餐廳標籤 -->
        ${
          post.restaurant_id && post.restaurant_name
            ? `
              <div
                class="feed-restaurant"
                onclick="window.location.href='detail.html?id=${post.restaurant_id}'"
              >
                📍 ${escapeHtml(post.restaurant_name)}
              </div>
            `
            : ""
        }

        <!-- ❤️ 按讚 + 💬 留言 -->
        <div class="feed-actions">
          <button
            type="button"
            class="feed-like-btn ${post.liked_by_me ? "liked" : ""}"
            onclick="togglePostLike(${post.post_id || post.id}, this)"
            title="按讚"
          >
            <span class="heart-icon">
              ${post.liked_by_me ? "♥" : "♡"}
            </span>
          </button>

          <button
            type="button"
            class="feed-comment-btn"
            onclick="openPostCommentModal(${post.post_id || post.id})"
            title="留言"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9 L3 21l1.9-5.7 a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9 h.5 a8.5 8.5 0 0 1 8 8 v.5z"></path>
            </svg>
          </button>
        </div>

        <!-- 讚數 -->
        <div
          class="feed-like-count"
          id="likeCount-${post.post_id || post.id}"
        >
          ${
            Number(post.like_count || 0) > 0
              ? `${Number(post.like_count)} 個讚`
              : ""
          }
        </div>

        <!-- 留言區 -->
        <div class="post-comments-area" id="commentsArea-${post.post_id || post.id}">
          ${
            Number(post.comment_count || 0) > 0
              ? `
                <button
                  type="button"
                  class="view-comments-btn"
                  onclick="openPostCommentModal(${post.post_id || post.id})"
                >
                  查看全部 ${Number(post.comment_count)} 則留言
                </button>
              `
              : `
                <button
                  type="button"
                  class="view-comments-btn"
                  style="color: #bbb;"
                  onclick="openPostCommentModal(${post.post_id || post.id})"
                >
                  新增留言...
                </button>
              `
          }
        </div>

        <!-- 時間 -->
        <div class="feed-bottom-time">
          ${escapeHtml(timeText)}
        </div>

      </div>
    </div>
  `;
}

// ============================================================
// 🗑️ 刪除貼文功能 (全域函數)
// ============================================================

async function deletePost(postId) {
  if (!postId) {
    alert("無效的貼文 ID");
    return;
  }

  // 1. 跳出二次確認彈窗
  if (!confirm("確定要刪除這篇貼文嗎？刪除後將無法復原。")) {
    return;
  }

  const token = getToken();
  if (!token) {
    alert("請先登入！");
    return;
  }

  try {
    // 2. 向後端發送 DELETE 請求
    const res = await fetch(`/api/posts/${postId}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || data.message || "刪除貼文失敗");
    }

    // 3. 從前端 DOM 畫面移除該貼文卡片
    const postElement = document.getElementById(`post-${postId}`);
    if (postElement) {
      postElement.style.transition = "all 0.3s ease";
      postElement.style.opacity = "0";
      postElement.style.transform = "scale(0.95)";
      setTimeout(() => {
        postElement.remove();
      }, 300);
    } else {
      // 備用機制：若找不到卡片 DOM 元素則重新載入動態牆
      if (typeof loadFriendFeeds === "function") {
        await loadFriendFeeds();
      }
    }

  } catch (err) {
    console.error("刪除貼文失敗:", err);
    alert(err.message || "刪除貼文失敗");
  }
}

// ============================================================
// 👥 載入好友動態上方頭像
// ============================================================

async function loadFeedFriendAvatars() {
  const container = document.getElementById("feedFriendAvatars");
  if (!container) return;

  const token = getToken();

  // 🎯 1. 發布動態按鈕 HTML
  const createBtnHtml = `
    <div class="feed-friend-avatar-item" onclick="openCreatePostModal()">
      <div class="feed-friend-avatar-circle" style="background: #ff5722; color: #fff; font-weight: bold;">
        ➕
      </div>
      <div class="feed-friend-avatar-name">
        發布
      </div>
    </div>
  `;

  if (!token) {
    container.innerHTML = createBtnHtml;
    return;
  }

  try {
    const res = await fetch("/api/friends", { headers: getAuthHeaders() });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "載入好友失敗");
    }

    const friends = data.friends || [];

    let html = `
      ${createBtnHtml}

      <div class="feed-friend-avatar-item active" onclick="showAllFriendFeeds(this)">
        <div class="feed-friend-avatar-circle feed-all-avatar-circle">
          👥
        </div>
        <div class="feed-friend-avatar-name">
          全部
        </div>
      </div>
    `;

    html += friends.map(friend => {
      const nickname = friend.nickname || "好友";
      const initial = nickname.charAt(0).toUpperCase();

      return `
        <div
          class="feed-friend-avatar-item"
          onclick="selectFriendFeed(${friend.user_id}, '${escapeJsString(nickname)}', this)"
        >
          <div class="feed-friend-avatar-circle">
            ${escapeHtml(initial)}
          </div>
          <div class="feed-friend-avatar-name">
            ${escapeHtml(nickname)}
          </div>
        </div>
      `;
    }).join("");

    container.innerHTML = html;

  } catch (err) {
    console.error("載入好友頭像失敗:", err);
    container.innerHTML = createBtnHtml;
  }
}


// ============================================================
// 👤 點好友頭像
// ============================================================

async function selectFriendFeed(userId, nickname, element) {
  document.querySelectorAll(".feed-friend-avatar-item").forEach(item => {
    item.classList.remove("active");
  });
  element?.classList.add("active");

  const container = document.getElementById("friendFeedList");
  if (!container) return;

  const token = getToken();
  if (!token) {
    container.innerHTML = '<p class="empty-msg">請先登入才能查看好友動態</p>';
    return;
  }

  container.innerHTML = '<p class="empty-msg">動態載入中...</p>';

  try {
    const res = await fetch(`/api/friends/posts/user/${userId}`, {
      headers: getAuthHeaders()
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "無法取得該好友動態");
    }

    if (!data.posts || data.posts.length === 0) {
      container.innerHTML = `
        <p class="empty-msg">
          ${escapeHtml(nickname)} 目前還沒有發布任何動態喔 📸
        </p>
      `;
      return;
    }

    // 🎯 直接使用通用卡片渲染器
    container.innerHTML = data.posts.map(post => renderPostCardHtml(post, nickname)).join("");

  } catch (err) {
    console.error("載入好友動態失敗:", err);
    container.innerHTML = `<p class="empty-msg" style="color:#e53e3e;">${escapeHtml(err.message)}</p>`;
  }
}


// ============================================================
// 👥 顯示全部好友動態
// ============================================================

async function showAllFriendFeeds(element) {
  document.querySelectorAll(".feed-friend-avatar-item").forEach(item => {
    item.classList.remove("active");
  });
  element?.classList.add("active");

  await loadFriendFeeds();
}

async function loadFriendFeeds() {
  const container = document.getElementById("friendFeedList");
  if (!container) return;

  const token = getToken();
  if (!token) {
    container.innerHTML = '<p class="empty-msg">請先登入才能查看好友動態</p>';
    return;
  }

  container.innerHTML = '<p class="empty-msg">動態載入中...</p>';

  try {
    // 🎯 關鍵修改：將 fetch 改為 apiFetch（apiFetch 內部會自動處理 headers 與 401/403 逾時跳轉）
    const res = await apiFetch("/api/friends/posts/feed");

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "無法取得好友動態");
    }

    if (!data.posts || data.posts.length === 0) {
      container.innerHTML = '<p class="empty-msg">目前沒有好友動態，快去新增好友吧！ 📸</p>';
      return;
    }

    // 🎯 直接使用通用卡片渲染器
    container.innerHTML = data.posts.map(post => renderPostCardHtml(post)).join("");

  } catch (err) {
    console.error("載入好友動態失敗:", err);
    container.innerHTML = `<p class="empty-msg" style="color:#e53e3e;">${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================
// 📷 拍照加入貼文
// ============================================================
function handlePostCamera(event) {
  const cameraInput = event.target;

  if (!cameraInput.files || cameraInput.files.length === 0) {
    return;
  }

  const cameraFile = cameraInput.files[0];

  const imageInput =
    document.getElementById("postImageInput");

  if (!imageInput) return;

  // 原本已選的照片
  const oldFiles =
    Array.from(imageInput.files || []);

  // 最多 5 張
  if (oldFiles.length >= 5) {
    alert("一篇貼文最多 5 張照片");
    cameraInput.value = "";
    return;
  }

  // 把「原本照片 + 剛拍的照片」合併
  const dt = new DataTransfer();

  oldFiles.forEach(file => {
    dt.items.add(file);
  });

  dt.items.add(cameraFile);

  imageInput.files = dt.files;

  // 使用你原本的多圖預覽
  previewPostImages({
    target: imageInput
  });

  // 清空相機 input，讓下次還能再拍
  cameraInput.value = "";
}

function updateCarouselDots(track) {

  const carousel =
    track.closest(".feed-carousel");

  if (!carousel) return;

  const slides =
    track.querySelectorAll(
      ".feed-carousel-slide"
    );

  if (!slides.length) return;

  const slideWidth =
    track.clientWidth;

  if (!slideWidth) return;

  let index =
    Math.round(
      track.scrollLeft / slideWidth
    );

  index = Math.max(
    0,
    Math.min(index, slides.length - 1)
  );


  // 更新下面圓點
  const dots =
    carousel.querySelectorAll(
      ".feed-carousel-dot"
    );

  dots.forEach((dot, dotIndex) => {

    dot.classList.toggle(
      "active",
      dotIndex === index
    );

  });


  // 更新右上角 1 / 3
  const count =
    carousel.querySelector(
      ".feed-carousel-count"
    );

  if (count) {
    count.textContent =
      `${index + 1} / ${slides.length}`;
  }
}


// ============================================================
// ❤️ 貼文按讚 / 取消按讚
// ============================================================

async function togglePostLike(postId, button) {
  const token = getToken();

  if (!token) {
    alert("請先登入");
    switchToLogin();
    return;
  }

  if (button.disabled) return;

  button.disabled = true;

  try {
    const res = await fetch(
      `/api/posts/${postId}/like`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    // 先讀文字，避免後端回 HTML 時直接 res.json() 爆掉
    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (jsonError) {
      console.error("按讚 API 回傳的不是 JSON：", text);
      throw new Error(
        `按讚 API 錯誤 (${res.status})`
      );
    }

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "按讚失敗"
      );
    }

    // ❤️ 更新愛心
    const heart =
      button.querySelector(".heart-icon");

    if (data.liked) {
      button.classList.add("liked");

      if (heart) {
        heart.textContent = "♥";
      }
    } else {
      button.classList.remove("liked");

      if (heart) {
        heart.textContent = "♡";
      }
    }

    // ❤️ 更新讚數
    const countElement =
      document.getElementById(
        `likeCount-${postId}`
      );

    if (countElement) {
      const count =
        Number(data.like_count || 0);

      countElement.textContent =
        count > 0
          ? `${count} 個讚`
          : "";
    }

  } catch (err) {
    console.error(
      "按讚失敗:",
      err
    );

    alert(
      err.message || "按讚失敗"
    );

  } finally {
    button.disabled = false;
  }
}

// ============================================================
// 💬 展開 / 收合留言
// ============================================================

async function togglePostComments(postId, forceOpenAll = false) {
  const list = document.getElementById(`commentsList-${postId}`);
  const form = document.getElementById(`commentForm-${postId}`);

  if (!list || !form) return;

  // 如果原本已經打開，且不是要強制展開全部，點擊則收起
  if (list.style.display !== "none" && !forceOpenAll && list.dataset.expanded === "true") {
    list.style.display = "none";
    form.style.display = "none";
    list.dataset.expanded = "false";
    return;
  }

  list.style.display = "block";
  form.style.display = "flex";

  // 若尚未載入或要展開更多
  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "取得留言失敗");

    // 紀錄是否已完全展開
    const showAll = forceOpenAll || list.dataset.expanded === "true";
    if (forceOpenAll) list.dataset.expanded = "true";

    renderPostComments(postId, data.comments || [], showAll);

  } catch (err) {
    console.error("取得留言失敗:", err);
    list.innerHTML = `<div class="comments-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderPostComments(postId, comments, showAll = false) {
  const list = document.getElementById(`commentsList-${postId}`);
  const viewBtn = document.getElementById(`viewCommentsBtn-${postId}`);
  if (!list) return;

  if (!comments.length) {
    list.innerHTML = `<div class="no-comments">還沒有留言，快來搶頭香！</div>`;
    if (viewBtn) viewBtn.style.display = "none";
    return;
  }

  // 判斷要顯示幾則：預設最多 3 則，展開後顯示全部
  const limit = 3;
  const hasMore = comments.length > limit;
  const displayComments = showAll ? comments : comments.slice(0, limit);

  // 渲染留言列表
  list.innerHTML = displayComments.map(comment => {
    const nickname = comment.nickname || comment.student_id || "使用者";
    return `
      <div class="post-comment-item">
        <span class="post-comment-author">${escapeHtml(nickname)}</span>
        <span class="post-comment-text">${escapeHtml(comment.content)}</span>
      </div>
    `;
  }).join("");

  // 更新或控制「查看全部留言」按鈕
  if (viewBtn) {
    if (hasMore && !showAll) {
      viewBtn.style.display = "block";
      viewBtn.textContent = `查看全部 ${comments.length} 則留言`;
      viewBtn.onclick = () => togglePostComments(postId, true); // 點擊展開全部
    } else {
      viewBtn.style.display = "none";
    }
  }
}

async function submitPostComment(postId) {
  const input = document.getElementById(`commentInput-${postId}`);
  if (!input) return;

  const content = input.value.trim();
  if (!content) return;

  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({ content })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "留言失敗");

    input.value = ""; // 清空輸入框

    // 重新抓取並渲染最新留言（保持當前展開狀態）
    const list = document.getElementById(`commentsList-${postId}`);
    const isExpanded = list?.dataset.expanded === "true";
    
    // 如果剛才沒打開，發布後自動開啟留言區
    if (list) list.style.display = "block";
    const form = document.getElementById(`commentForm-${postId}`);
    if (form) form.style.display = "flex";

    await togglePostComments(postId, isExpanded);

  } catch (err) {
    console.error("留言失敗:", err);
    alert(err.message || "留言失敗");
  }
}

// ============================================================
// 👆 長按好友
// ============================================================

let friendLongPressTimer = null;
let friendLongPressTriggered = false;


// 開始長按
function startFriendLongPress(
  friendshipId,
  nickname
) {
  friendLongPressTriggered = false;

  clearTimeout(friendLongPressTimer);

  friendLongPressTimer = setTimeout(() => {

    friendLongPressTriggered = true;

    deleteFriend(
      friendshipId,
      nickname
    );

  }, 700);
}


// 放開 / 移出
function cancelFriendLongPress() {
  clearTimeout(friendLongPressTimer);
  friendLongPressTimer = null;
}


// 一般點一下
function handleFriendClick(userId, nickname, element) { // 🎯 加上 element 參數
  if (friendLongPressTriggered) {
    friendLongPressTriggered = false;
    return;
  }

  openUserProfile(userId, nickname, element);
}

// ============================================================
// 🗑️ 刪除好友
// ============================================================

async function deleteFriend(
  friendshipId,
  nickname
) {

  const token = getToken();

  if (!token) {
    alert("請先登入");
    return;
  }

  const confirmed = confirm(
    `確定要刪除「${nickname}」嗎？\n刪除後你們將不再是好友。`
  );

  if (!confirmed) return;


  try {

    const res = await fetch(
      `/api/friends/${friendshipId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "刪除好友失敗"
      );
    }


    // 重新載入好友列表
    await loadMyFriends();

    // 上面好友頭像列也一起更新
    if (
      typeof loadFeedFriendAvatars === "function"
    ) {
      await loadFeedFriendAvatars();
    }


  } catch (err) {

    console.error(
      "刪除好友失敗:",
      err
    );

    alert(
      err.message || "刪除好友失敗"
    );
  }
}


// 防止 nickname 裡有單引號造成 onclick 壞掉
function escapeJsString(str = "") {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}


// ==================== 6. 載入我的好友 ====================
async function loadMyFriends() {
  const container = document.getElementById("myFriendsList");
  if (!container) return;

  try {
    const res = await fetch("/api/friends", {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "載入好友列表失敗");
    }

    // 渲染好友清單
    renderMyFriends(data.friends);

  } catch (err) {
    console.error("載入好友列表失敗:", err);
    container.innerHTML = `<p class="empty-msg" style="color:#e53e3e;">${escapeHtml(err.message)}</p>`;
  }
}

function renderMyFriends(friends) {
  const container = document.getElementById("myFriendsList");
  if (!container) return;

  if (!friends || friends.length === 0) {
    container.innerHTML = `<p class="empty-msg">目前還沒有好友喔，快去新增好友吧！ 👥</p>`;
    return;
  }

  // 1. 產生所有好友卡片的 HTML[cite: 2]
  const friendsHtml = friends.map(friend => {
    const nickname = friend.nickname || friend.student_id || "好友";
    const initial = nickname.charAt(0).toUpperCase();

    return `
      <div 
        class="friend-item"
        onmousedown="startFriendLongPress(${friend.friendship_id}, '${escapeJsString(nickname)}')"
        ontouchstart="startFriendLongPress(${friend.friendship_id}, '${escapeJsString(nickname)}')"
        onmouseup="cancelFriendLongPress()"
        onmouseleave="cancelFriendLongPress()"
        ontouchend="cancelFriendLongPress()"
        onclick="handleFriendClick(${friend.user_id}, '${escapeJsString(nickname)}')"
      >
        <div class="friend-avatar">${escapeHtml(initial)}</div>
        <div class="friend-info">
          <span class="friend-name">${escapeHtml(nickname)}</span>
          <span class="friend-id">學號：${escapeHtml(friend.student_id || "")}</span>
        </div>
      </div>
    `;
  }).join("");

  // 2. 在好友卡片下方拼接提示文字 💡
  const hintHtml = `
    <div style="text-align: center; color: #a0a0a0; font-size: 0.8rem; margin-top: 18px; padding-bottom: 10px;">
      💡 提示：長按好友即可進行刪除
    </div>
  `;

  // 3. 組合後寫入 DOM[cite: 2]
  container.innerHTML = friendsHtml + hintHtml;
}


// ==================== 7. 查看某位好友的貼文 ====================
async function openUserProfile(userId, nickname, element = null) {
  // 1. 切換 Modal 頁籤至「好友動態 (tab-feed)」
  document.querySelectorAll(".friends-tabs .tab-btn").forEach(tab => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".friends-modal-body .tab-content").forEach(content => {
    content.classList.remove("active");
  });

  // 啟用 好友動態 的 tab 與 content
  document.getElementById("tab-feed")?.classList.add("active");
  const feedTabBtn = document.querySelector(`.tab-btn[onclick*="'feed'"]`);
  if (feedTabBtn) feedTabBtn.classList.add("active");

  // 2. 呼叫既有的 selectFriendFeed，直接在動態頁面上載入該好友的動態與頭像 active 狀態
  await selectFriendFeed(userId, nickname, element);
}


// ==================== 8. 搜尋好友 ====================
// ============================================================
// 🔍 搜尋好友
// ============================================================
async function searchUsers() {

  const input =
    document.getElementById("friendSearchInput");

  const resultContainer =
    document.getElementById("friendSearchResults");

  if (!input || !resultContainer) {
    console.error("找不到好友搜尋欄位");
    return;
  }

  const studentId =
    input.value.trim();

  // ==============================
  // 基本檢查
  // ==============================
  if (!studentId) {
    alert("請輸入學號進行搜尋！");
    input.focus();
    return;
  }

  if (!/^[0-9]{8}$/.test(studentId)) {
    alert("學號必須是 8 位數字");
    input.focus();
    return;
  }

  resultContainer.innerHTML = `
    <p class="empty-msg">
      搜尋中...
    </p>
  `;

  try {

    const res = await fetch(
      `/api/friends/search?studentId=${encodeURIComponent(studentId)}`,
      {
        headers: getAuthHeaders()
      }
    );

    const data =
      await res.json();

    if (!res.ok || !data.ok) {

      resultContainer.innerHTML = `
        <p
          class="empty-msg"
          style="color:#e53e3e;"
        >
          ${escapeHtml(
            data.error ||
            "找不到該使用者"
          )}
        </p>
      `;

      return;
    }

    const user =
      data.user;

    const friendshipStatus =
      data.friendshipStatus || "NONE";

    let buttonHtml = "";

    // ==============================
    // 已經是好友
    // ==============================
    if (friendshipStatus === "ACCEPTED") {

      buttonHtml = `
        <button
          class="action-btn"
          disabled
          style="
            background:#ccc;
            cursor:not-allowed;
          "
        >
          已是好友
        </button>
      `;

    }

    // ==============================
    // 🎯 邀請等待處理（修正處：改為取消申請按鈕）
    // ==============================
    else if (friendshipStatus === "PENDING") {

      buttonHtml = `
        <button
          class="action-btn cancel"
          onclick="cancelFriendRequest(${user.id})"
        >
          取消申請
        </button>
      `;

    }

    // ==============================
    // 尚未成為好友
    // ==============================
    else {

      buttonHtml = `
        <button
          class="action-btn success"
          onclick="sendFriendRequest(${user.id})"
        >
          ＋ 加為好友
        </button>
      `;

    }

    // ==============================
    // 顯示搜尋結果
    // ==============================
    resultContainer.innerHTML = `

      <div class="friend-item">

        <div class="friend-avatar">
          👤
        </div>

        <div class="friend-info">

          <span class="friend-name">
            ${escapeHtml(
              user.nickname ||
              "中原同學"
            )}
          </span>

          <span class="friend-id">
            學號：
            ${escapeHtml(
              user.student_id ||
              ""
            )}
          </span>

        </div>

        <div
          id="search-action-${user.id}"
        >
          ${buttonHtml}
        </div>

      </div>
    `;

  } catch (err) {

    console.error(
      "搜尋使用者失敗:",
      err
    );

    resultContainer.innerHTML = `
      <p
        class="empty-msg"
        style="color:#e53e3e;"
      >
        搜尋時發生錯誤
      </p>
    `;

  }
}


// ==================== 9. 發送好友邀請 ====================
async function sendFriendRequest(targetUserId) {
  const actionContainer = document.getElementById(
    `search-action-${targetUserId}`
  );

  try {
    const res = await fetch("/api/friends/request", {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({
        targetUserId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      alert(data.error || "發送邀請失敗");
      return;
    }

    alert(data.message || "好友邀請已成功發送！");

    // 🎯 發送成功後，將按鈕改為「取消申請」按鈕
    if (actionContainer) {
      actionContainer.innerHTML = `
        <button
          class="action-btn cancel"
          onclick="cancelFriendRequest(${targetUserId})"
        >
          取消申請
        </button>
      `;
    }

  } catch (err) {
    console.error("發送好友邀請失敗:", err);
    alert("伺服器錯誤，請稍後再試");
  }
}

// ==================== 🎯 收回/取消好友邀請 ====================
async function cancelFriendRequest(targetUserId) {
  if (!confirm("確定要收回這筆好友申請嗎？")) return;

  const actionContainer = document.getElementById(
    `search-action-${targetUserId}`
  );

  try {
    const res = await fetch("/api/friends/cancel", {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({
        targetUserId
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      alert(data.error || "收回邀請失敗");
      return;
    }

    alert(data.message || "已成功取消好友申請！");

    // 收回成功後，把按鈕恢復為「加為好友」按鈕
    if (actionContainer) {
      actionContainer.innerHTML = `
        <button
          class="action-btn success"
          onclick="sendFriendRequest(${targetUserId})"
        >
          ＋ 加為好友
        </button>
      `;
    }

  } catch (err) {
    console.error("收回好友邀請失敗:", err);
    alert("伺服器錯誤，請稍後再試");
  }
}

// ==================== 10. 好友申請畫面 ====================
function renderRequests(requests) {
  const requestsList = document.getElementById("requestsList");

  if (!requestsList) return;

  if (!requests || requests.length === 0) {
    requestsList.innerHTML =
      '<p class="empty-msg">目前沒有新的好友申請 ✉️</p>';
    return;
  }

  requestsList.innerHTML = requests.map(req => `
    <div
      class="friend-item"
      id="request-${req.friendship_id}"
    >
      <div class="friend-avatar">
        📩
      </div>

      <div class="friend-info">
        <span class="friend-name">
          ${escapeHtml(req.nickname || "中原同學")}
        </span>

        <span class="friend-id">
          學號：${escapeHtml(req.student_id || "")}
        </span>
      </div>

      <div class="btn-group">
        <button
          class="action-btn success"
          onclick="respondRequest(${req.friendship_id}, 'ACCEPT')"
        >
          同意
        </button>

        <button
          class="action-btn danger"
          onclick="respondRequest(${req.friendship_id}, 'REJECT')"
        >
          拒絕
        </button>
      </div>
    </div>
  `).join("");
}


// ==================== 11. 載入好友申請 ====================
async function loadFriendRequests() {
  const container =
    document.getElementById("requestsList");

  if (!container) return;

  container.innerHTML =
    '<p class="empty-msg">申請載入中...</p>';

  try {

    const res = await fetch(
      "/api/friends/requests",
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {

      throw new Error(
        data.error ||
        "載入好友申請失敗"
      );
    }

    renderRequests(data.requests);

    updateFriendBadge(
      data.requests
        ? data.requests.length
        : 0
    );

  } catch (err) {

    console.error(
      "載入好友申請失敗:",
      err
    );

    container.innerHTML =
      `<p
        class="empty-msg"
        style="color:#e53e3e;"
      >
        ${escapeHtml(err.message)}
      </p>`;
  }
}


// ==================== 12. 同意 / 拒絕好友 ====================
async function respondRequest(
  friendshipId,
  action
) {

  try {

    const res = await fetch(
      "/api/friends/respond",
      {
        method: "PUT",

        headers:
          getAuthHeaders(true),

        body: JSON.stringify({
          friendshipId,
          action
        })
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {

      alert(
        data.error ||
        "操作失敗"
      );

      return;
    }

    alert(
      data.message ||
      "操作成功！"
    );

    // 重新讀取申請
    await loadFriendRequests();

    // 如果接受就重新讀取好友
    if (action === "ACCEPT") {
      await loadMyFriends();
    }

  } catch (err) {

    console.error(
      "處理好友申請失敗:",
      err
    );

    alert(
      "伺服器錯誤，請稍後再試"
    );
  }
}


// ==================== 13. 好友申請通知數 ====================
function updateFriendBadge(count) {

  const badge =
    document.getElementById("friendBadge");

  const tabBadge =
    document.getElementById("tabBadge");

  if (badge) {

    badge.textContent = count;

    badge.style.display =
      count > 0
        ? "inline-block"
        : "none";
  }

  if (tabBadge) {

    tabBadge.textContent = count;

    tabBadge.style.display =
      count > 0
        ? "inline-block"
        : "none";
  }
}


// ==================== 14. 點遮罩關閉 ====================
document.addEventListener(
  "DOMContentLoaded",
  () => {

    document
      .getElementById("friendsModal")
      ?.addEventListener(
        "click",
        function(e) {

          if (e.target === this) {
            closeFriendsModal();
          }

        }
      );

    // 已登入就抓一次好友申請數量
    if (getToken()) {
      loadFriendRequests();
    }

  }
);

// ============================================================
// 📝 發布貼文功能
// ============================================================

let selectedPostRestaurant = null;


// ============================================================
// 🔎 搜尋 Tag 餐廳
// ============================================================
async function searchPostRestaurants(keyword) {

  const resultBox =
    document.getElementById("postRestaurantResults");

  if (!resultBox) return;

  const q = String(keyword || "").trim();

  if (!q) {
    resultBox.innerHTML = "";
    resultBox.style.display = "none";
    return;
  }

  const token = getToken();

  if (!token) return;

  try {

    const res = await fetch(
      `/api/posts/restaurants/search?q=${encodeURIComponent(q)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "搜尋餐廳失敗"
      );
    }

    if (
      !data.restaurants ||
      data.restaurants.length === 0
    ) {
      resultBox.style.display = "block";

      resultBox.innerHTML = `
        <div class="restaurant-search-empty">
          找不到符合的餐廳
        </div>
      `;

      return;
    }

    resultBox.style.display = "block";

    resultBox.innerHTML =
      data.restaurants.map(restaurant => `

        <div
          class="post-restaurant-item"
          onclick="selectPostRestaurant(
            ${restaurant.id},
            '${escapeJsString(restaurant.name)}'
          )"
        >

          <div class="post-restaurant-name">
            📍 ${escapeHtml(restaurant.name)}
          </div>

          ${
            restaurant.address
              ? `
                <div class="post-restaurant-address">
                  ${escapeHtml(restaurant.address)}
                </div>
              `
              : ""
          }

        </div>

      `).join("");

  } catch (error) {

    console.error(
      "搜尋 Tag 餐廳失敗:",
      error
    );

    resultBox.style.display = "block";

    resultBox.innerHTML = `
      <div class="restaurant-search-empty">
        搜尋餐廳失敗
      </div>
    `;
  }
}


// ============================================================
// 📍 選擇餐廳
// ============================================================
function selectPostRestaurant(
  restaurantId,
  restaurantName
) {

  selectedPostRestaurant = {
    id: restaurantId,
    name: restaurantName
  };

  const searchInput =
    document.getElementById(
      "postRestaurantSearch"
    );

  const resultBox =
    document.getElementById(
      "postRestaurantResults"
    );

  const selectedBox =
    document.getElementById(
      "selectedRestaurantBox"
    );

  const selectedName =
    document.getElementById(
      "selectedRestaurantName"
    );

  if (searchInput) {
    searchInput.value = "";
  }

  if (resultBox) {
    resultBox.innerHTML = "";
    resultBox.style.display = "none";
  }

  if (selectedName) {
    selectedName.textContent =
      `📍 ${restaurantName}`;
  }

  if (selectedBox) {
    selectedBox.style.display = "flex";
  }
}


// ============================================================
// ❌ 取消 Tag 餐廳
// ============================================================
function clearPostRestaurant() {

  selectedPostRestaurant = null;

  const selectedBox =
    document.getElementById(
      "selectedRestaurantBox"
    );

  const selectedName =
    document.getElementById(
      "selectedRestaurantName"
    );

  if (selectedName) {
    selectedName.textContent = "";
  }

  if (selectedBox) {
    selectedBox.style.display = "none";
  }
}

// ============================================================
// ➕ 展開 / 收起發文區
// ============================================================
function toggleCreatePost() {
  const box =
    document.getElementById("createPostBox");

  const toolbar =
    document.getElementById("postToolbarActions");

  if (!box) return;

  const isOpen =
    box.style.display === "block";

  if (isOpen) {
    closeCreatePost();
    return;
  }

  box.style.display = "block";

  if (toolbar) {
    toolbar.style.display = "flex";
  }

  setTimeout(() => {
    document
      .getElementById("postContent")
      ?.focus();
  }, 50);
}

// ==================== 🧹 重置 AI 對話 (開始新對話) ====================
function resetAiChat() {
  // 1. 重置目前對話 ID 與收藏狀態
  currentConversationId = null;
  currentConversationIsFavorite = false;

   // 清空 AI 對話記憶
  aiHistoryMessages = [];

  // 清空上一輪推薦的餐廳
  lastRecommendedNames = [];
  activeMenuRestaurantName = "";
  lastFocusedNames = [];
  rejectedRestaurantNames = [];

  // 2. 清空聊天視窗畫面
  const aiOutput = document.getElementById("aiOutput");
  if (aiOutput) {
    aiOutput.innerHTML = "";
  }

  // 3. 清空輸入框
  const aiInput = document.getElementById("aiInput");
  if (aiInput) {
    aiInput.value = "";
  }

  // 4. 隱藏頂部標籤與恢復狀態
  const topStar = document.getElementById("aiActiveStarBtn");
  if (topStar) {
    topStar.style.display = "none";
  }

  // 5. 提示使用者已重置
  if (aiOutput) {
    aiOutput.innerHTML = `<p style="color: #888; text-align: center; margin-top: 10px; font-size: 0.85rem;">✨ 已開啟新對話，請隨時提出新的美食問題！</p><hr>`;
  }
}

// ============================================================
// 🖼️ 預覽多張貼文照片
// ============================================================
function previewPostImages(event) {
  const input = event.target;
  const files = Array.from(input.files || []);

  const previewBox =
    document.getElementById("postImagePreviewBox");

  if (!previewBox) return;

  previewBox.innerHTML = "";

  if (files.length === 0) {
    previewBox.style.display = "none";
    return;
  }

  if (files.length > 5) {
    alert("一篇貼文最多 5 張照片");
    input.value = "";
    previewBox.style.display = "none";
    return;
  }

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      alert("只能選擇圖片檔案");
      input.value = "";
      previewBox.style.display = "none";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert("每張圖片不能超過 5MB");
      input.value = "";
      previewBox.style.display = "none";
      return;
    }
  }

  previewBox.style.display = "flex";

  files.forEach((file) => {
    const reader = new FileReader();

    reader.onload = function(e) {
      const img = document.createElement("img");

      img.src = e.target.result;
      img.className = "post-image-preview";

      previewBox.appendChild(img);
    };

    reader.readAsDataURL(file);
  });
}


// ============================================================
// ❌ 清除貼文照片
// ============================================================
function clearPostImage() {
  const input =
    document.getElementById("postImageInput");

  const previewBox =
    document.getElementById("postImagePreviewBox");

  if (input) {
    input.value = "";
  }

  if (previewBox) {
    previewBox.innerHTML = "";
    previewBox.style.display = "none";
  }
}


// ============================================================
// ❌ 關閉發文區
// ============================================================
function closeCreatePost() {
  const box =
    document.getElementById("createPostBox");

  const toolbar =
    document.getElementById("postToolbarActions");

  const textarea =
    document.getElementById("postContent");

  const searchInput =
    document.getElementById("postRestaurantSearch");

  const resultBox =
    document.getElementById("postRestaurantResults");

  if (box) {
    box.style.display = "none";
  }

  if (toolbar) {
    toolbar.style.display = "none";
  }

  if (textarea) {
    textarea.value = "";
  }

  if (searchInput) {
    searchInput.value = "";
  }

  if (resultBox) {
    resultBox.innerHTML = "";
    resultBox.style.display = "none";
  }

  clearPostRestaurant();
  clearPostImage();
}



// ============================================================
// 🚀 發布貼文
// ============================================================
async function publishPost() {
  const token = getToken();

  if (!token) {
    alert("請先登入才能發布貼文！");
    openLoginModal();
    return;
  }

  const textarea = document.getElementById("postContent");
  if (!textarea) return;

  const content = textarea.value.trim();

  // 取得選到的圖片
  const imageInput = document.getElementById("postImageInput");
  const imageFiles = Array.from(imageInput?.files || []);

  // 檢查是否沒有內容也沒有選擇圖片
  if (!content && imageFiles.length === 0) {
    alert("請輸入貼文內容或選擇照片！");
    return;
  }

  if (content.length > 500) {
    alert("貼文最多 500 個字");
    return;
  }

  const publishButton = document.querySelector(".publish-post-btn");

  try {
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.textContent = "發布中...";
    }

    // 建立 FormData
    const formData = new FormData();
    formData.append("content", content);

    // 有 Tag 餐廳才加
    if (selectedPostRestaurant && selectedPostRestaurant.id) {
      formData.append("restaurantId", selectedPostRestaurant.id);
    }

    // 有選圖片才加
    imageFiles.forEach(file => {
      formData.append("images", file);
    });

    // 發送給後端
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "發布失敗");
    }

    // 清空與重置狀態
    textarea.value = "";
    if (imageInput) imageInput.value = ""; // 清空圖片選取
    if (typeof clearPostRestaurant === "function") {
      clearPostRestaurant();
    }

    closeCreatePost();
    await loadFriendFeeds();

  } catch (error) {
    console.error("發布貼文失敗:", error);
    alert(error.message || "發布貼文失敗");
  } finally {
    if (publishButton) {
      publishButton.disabled = false;
      publishButton.textContent = "發布";
    }
  }
}

// 全域變數定義
let selectedPostImages = [];
let selectedRestaurantId = null;

// 1. 開啟與關閉 Modal
function openCreatePostModal() {
  const token = localStorage.getItem('token');
  if (!token) {
    alert('請先登入才能發布動態！');
    if (typeof openLoginModal === 'function') openLoginModal();
    return;
  }
  document.getElementById('createPostModal').style.display = 'flex';
}

function closeCreatePostModal() {
  document.getElementById('createPostModal').style.display = 'none';
  document.getElementById('postContent').value = '';
  document.getElementById('postImagePreviewBox').innerHTML = '';
  document.getElementById('postImageInput').value = '';
  selectedPostImages = [];
  removeSelectedRestaurant();
}

// 2. 選擇與預覽圖片
function handlePostImageSelect(e) {
  const files = Array.from(e.target.files);
  
  if (selectedPostImages.length + files.length > 5) {
    alert('最多只能選擇 5 張照片');
    return;
  }

  const previewBox = document.getElementById('postImagePreviewBox');

  files.forEach(file => {
    selectedPostImages.push(file);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = document.createElement('img');
      img.src = event.target.result;
      img.style.width = '70px';
      img.style.height = '70px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '8px';
      previewBox.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
}

// 3. 搜尋可標記的餐廳 (對接 GET /api/posts/restaurants/search)
async function searchPostRestaurants() {
  const searchInput = document.getElementById('postRestaurantSearch');
  const resultsBox = document.getElementById('postRestaurantResults');
  const q = searchInput ? searchInput.value.trim() : '';
  
  if (!q) {
    resultsBox.innerHTML = '';
    resultsBox.style.display = 'none';
    return;
  }

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/posts/restaurants/search?q=${encodeURIComponent(q)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.ok && data.restaurants.length > 0) {
      resultsBox.innerHTML = data.restaurants.map(r => `
        <div onclick="selectRestaurant(${r.id}, '${r.name.replace(/'/g, "\\'")}')" style="padding: 8px; cursor: pointer; border-bottom: 1px solid #eee; text-align: left;">
          📍 <strong>${r.name}</strong> <small style="color: #888;">(${r.address || ''})</small>
        </div>
      `).join('');
      resultsBox.style.display = 'block';
    } else {
      resultsBox.innerHTML = '<div style="padding: 8px; color: #888;">找不到餐廳</div>';
      resultsBox.style.display = 'block';
    }
  } catch (err) {
    console.error('搜尋餐廳錯誤:', err);
  }
}

function selectRestaurant(id, name) {
  selectedRestaurantId = id;
  document.getElementById('selectedRestaurantName').innerText = `📍 ${name}`;
  document.getElementById('selectedRestaurantBox').style.display = 'block';
  document.getElementById('postRestaurantResults').style.display = 'none';
  document.getElementById('postRestaurantSearch').value = '';
}

function removeSelectedRestaurant() {
  selectedRestaurantId = null;
  document.getElementById('selectedRestaurantBox').style.display = 'none';
  document.getElementById('selectedRestaurantName').innerText = '';
}

// 4. 發布貼文送出 (對接 POST /api/posts)
async function submitPost() {
  const content = document.getElementById('postContent').value.trim();
  
  if (!content && selectedPostImages.length === 0) {
    alert('請輸入貼文內容或選擇照片！');
    return;
  }

  const formData = new FormData();
  formData.append('content', content);
  
  if (selectedRestaurantId) {
    formData.append('restaurantId', selectedRestaurantId);
  }

  selectedPostImages.forEach(file => {
    formData.append('images', file);
  });

  const token = localStorage.getItem('token');

  try {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();

    if (data.ok) {
      alert('🎉 貼文發布成功！');
      closeCreatePostModal();
      // 重新載入動態牆
      if (typeof loadFriendFeeds === 'function') {
        loadFriendFeeds();
      }
    } else {
      alert('發布失敗：' + (data.error || '未知錯誤'));
    }
  } catch (err) {
    console.error('發布貼文錯誤:', err);
    alert('發布失敗，請確認網路連線與登入狀態');
  }
}


// ============================================================
// ⌨️ Tag 餐廳搜尋框
// ============================================================

let postRestaurantSearchTimer = null;

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const input =
      document.getElementById(
        "postRestaurantSearch"
      );

    if (!input) return;

    input.addEventListener(
      "input",
      function() {

        clearTimeout(
          postRestaurantSearchTimer
        );

        const keyword =
          this.value.trim();

        postRestaurantSearchTimer =
          setTimeout(
            () => {
              searchPostRestaurants(
                keyword
              );
            },
            300
          );
      }
    );

  }
);

// ============================================================
// 👤 載入目前使用者資料
// ============================================================

async function loadCurrentUserProfile() {

  const token = getToken();

  if (!token) {
    return;
  }


  try {

    const res =
      await fetch(
        "/api/users/me",
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${token}`
          }
        }
      );


    const data =
      await res.json();


    if (
      !res.ok ||
      !data.ok
    ) {

      throw new Error(
        data.error ||
        "取得使用者資料失敗"
      );
    }


    const user =
      data.user;


    const nicknameInput =
      document.getElementById(
        "editUserNickname"
      );

    const usernameInput =
      document.getElementById(
        "editUserUsername"
      );

    const phoneInput =
      document.getElementById(
        "editUserPhone"
      );

    const displayName =
      document.getElementById(
        "editUserDisplayName"
      );

    const avatar =
      document.getElementById(
        "editUserAvatarCircle"
      );


    if (nicknameInput) {
      nicknameInput.value =
        user.nickname || "";
    }


    if (usernameInput) {
      usernameInput.value =
        user.username || "";
    }


    if (phoneInput) {
      phoneInput.value =
        user.phone || "";
    }


    if (displayName) {

      displayName.textContent =
        user.nickname ||
        user.username ||
        "使用者";
    }


    if (avatar) {

      avatar.textContent =
        (
          user.nickname ||
          user.username ||
          "使"
        ).charAt(0);
    }


  } catch (error) {

    console.error(
      "載入使用者資料失敗:",
      error
    );


    alert(
      "❌ " +
      (
        error.message ||
        "載入使用者資料失敗"
      )
    );
  }
}


function openUserPanel(tab) {
  const modal = document.getElementById("friendsModal");
  if (!modal) {
    alert("找不到好友/個人面板視窗");
    return;
  }

  // 💡 關鍵修正：確保選單立刻收起，不會浮在 Modal 上面
  const container = document.querySelector(".user-dropdown-container");
  if (container) {
    container.classList.remove("active");
  }

  modal.style.display = "flex";
  document.body.classList.add("modal-open");

  if (tab === "edit") {
    switchFriendTab("edit"); 
  } else if (tab === "friends") {
    switchFriendTab("feed");
  }
}

// ============================================================
// 💾 儲存使用者資料
// ============================================================

async function saveUserProfile() {
  const token = getToken();

  if (!token) {
    alert("請先登入");
    openLoginModal();
    return;
  }

  const nicknameInput = document.getElementById("editUserNickname");
  const phoneInput = document.getElementById("editUserPhone");

  const nickname = nicknameInput?.value.trim() || "";
  const phone = phoneInput?.value.trim() || "";

  // 1. 檢查是否兩個欄位都沒填
  if (!nickname && !phone) {
    alert("請至少填寫「暱稱」或「手機號碼」其中一項！");
    return;
  }

  // 2. 有填暱稱時才檢查長度
  if (nickname && (nickname.length < 1 || nickname.length > 20)) {
    alert("暱稱必須為 1～20 個字");
    nicknameInput?.focus();
    return;
  }

  // 3. 有填手機時才檢查格式
  if (phone && !/^09\d{8}$/.test(phone)) {
    alert("手機號碼必須為 09 開頭的 10 位數字");
    phoneInput?.focus();
    return;
  }

  try {
    const res = await fetch("/api/users/me", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        nickname,
        phone
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "儲存失敗");
    }

    // 更新 localStorage 快取
    if (data.user?.nickname) {
      localStorage.setItem("nickname", data.user.nickname);
    }

    // 更新畫面顯示
    const displayName = document.getElementById("editUserDisplayName");
    if (displayName) {
      displayName.textContent = data.user?.nickname || data.user?.username || "使用者";
    }

    const avatar = document.getElementById("editUserAvatarCircle");
    if (avatar) {
      avatar.textContent = (data.user?.nickname || data.user?.username || "使").charAt(0);
    }

    setupUserIcon();
    alert("✅ 使用者資料已儲存");
    closeEditUserModal();

  } catch (error) {
    console.error("儲存使用者資料失敗：", error);
    alert("❌ " + (error.message || "儲存失敗"));
  }
}

// =====================================================
// 👤 右上角使用者選單與全域監聽器
// =====================================================
document.addEventListener("DOMContentLoaded", () => {
  const userDropdown = document.querySelector(".user-dropdown-container");

  // 1. 點選單裡面時，不要因為冒泡觸發到全域關閉
  if (userDropdown) {
    userDropdown.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  // 2. 點擊頁面其他任何地方時，自動關閉下拉選單
  document.addEventListener("click", () => {
    if (userDropdown) {
      userDropdown.classList.remove("active");
    }
  });
});

// 分類標籤向右滑動按鈕
function scrollCategoriesRight() {
  const container = document.getElementById("categoryContainer");
  if (container) {
    container.scrollBy({ left: 180, behavior: "smooth" });
  }
}

// ============================================================
// 💬 Modal 留言彈出視窗控制邏輯
// ============================================================

// 1. 開啟留言 Modal 並載入該貼文留言
async function openPostCommentModal(postId) {
  const modal = document.getElementById("postCommentModal");
  const hiddenInput = document.getElementById("modalCurrentPostId");
  const commentsList = document.getElementById("modalCommentsList");
  const input = document.getElementById("modalCommentInput");

  if (!modal || !hiddenInput || !commentsList) return;

  hiddenInput.value = postId;
  if (input) input.value = "";
  commentsList.innerHTML = `<div class="no-comments">載入留言中...</div>`;
  modal.style.display = "flex";

  await fetchAndRenderModalComments(postId);
}

// 2. 關閉留言 Modal
function closePostCommentModal() {
  const modal = document.getElementById("postCommentModal");
  if (modal) {
    modal.style.display = "none";
  }
}

// 3. 從後端取得留言並繪製於 Modal 內
async function fetchAndRenderModalComments(postId) {
  const commentsList = document.getElementById("modalCommentsList");
  if (!commentsList) return;

  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "取得留言失敗");

    const comments = data.comments || [];

    if (comments.length === 0) {
      commentsList.innerHTML = `<div class="no-comments">還沒有留言，快來搶頭香！</div>`;
      return;
    }

    commentsList.innerHTML = comments.map(comment => {
      const nickname = comment.nickname || comment.student_id || "使用者";
      return `
        <div class="post-comment-item" style="padding: 6px 0; border-bottom: 1px dashed #f5f5f5;">
          <span class="post-comment-author">${escapeHtml(nickname)}</span>
          <span class="post-comment-text">${escapeHtml(comment.content)}</span>
        </div>
      `;
    }).join("");

    // 讓留言列表自動捲動到底部
    commentsList.scrollTop = commentsList.scrollHeight;

  } catch (err) {
    console.error("取得留言失敗:", err);
    commentsList.innerHTML = `<div class="no-comments" style="color:red;">${escapeHtml(err.message)}</div>`;
  }
}

// 4. 在 Modal 中送出留言
async function submitModalComment() {
  const hiddenInput = document.getElementById("modalCurrentPostId");
  const input = document.getElementById("modalCommentInput");

  if (!hiddenInput || !input) return;

  const postId = Number(hiddenInput.value);
  const content = input.value.trim();

  if (!postId || !content) return;

  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({ content })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "留言失敗");

    input.value = ""; // 清空輸入框

    // 重新載入 Modal 內的最新留言
    await fetchAndRenderModalComments(postId);

    // 重新繪製動態牆，讓卡片上的留言計數（comment_count）同步更新
    if (typeof loadFriendFeeds === "function") {
      loadFriendFeeds();
    }

  } catch (err) {
    console.error("留言失敗:", err);
    alert(err.message || "留言失敗");
  }
}

// 1. 渲染 Modal 留言（加入刪除按鈕）
async function fetchAndRenderModalComments(postId) {
  const commentsList = document.getElementById("modalCommentsList");
  if (!commentsList) return;

  try {
    const res = await fetch(`/api/posts/${postId}/comments`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "取得留言失敗");

    const comments = data.comments || [];

    if (comments.length === 0) {
      commentsList.innerHTML = `<div class="no-comments">還沒有留言，快來搶頭香！</div>`;
      return;
    }

    commentsList.innerHTML = comments.map(comment => {
      const nickname = comment.nickname || comment.student_id || "使用者";
      
      // 如果可以刪除，顯示小垃圾桶圖示 🗑️
      const deleteBtnHtml = comment.can_delete 
        ? `<button type="button" onclick="deleteModalComment(${comment.id}, ${postId})" style="background:none; border:none; color:#888; cursor:pointer; font-size:0.85rem; padding:2px 5px;" title="刪除留言">🗑️</button>` 
        : "";

      return `
        <div id="comment-item-${comment.id}" class="post-comment-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px dashed #f0f0f0;">
          <div style="flex: 1; padding-right: 10px;">
            <span class="post-comment-author">${escapeHtml(nickname)}</span>：
            <span class="post-comment-text">${escapeHtml(comment.content)}</span>
          </div>
          ${deleteBtnHtml}
        </div>
      `;
    }).join("");

    commentsList.scrollTop = commentsList.scrollHeight;

  } catch (err) {
    console.error("取得留言失敗:", err);
    commentsList.innerHTML = `<div class="no-comments" style="color:red;">${escapeHtml(err.message)}</div>`;
  }
}

// 2. 執行刪除留言動作
async function deleteModalComment(commentId, postId) {
  if (!confirm("確定要刪除這條留言嗎？")) return;

  try {
    const res = await fetch(`/api/posts/comments/${commentId}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      alert(data.error || "刪除留言失敗");
      return;
    }

    // A. 重新抓取 Modal 留言
    await fetchAndRenderModalComments(postId);

    // B. 同步更新背後主畫面卡片上的動態牆（留言總數會自動重新計算）
    if (typeof loadFriendFeeds === "function") {
      loadFriendFeeds();
    }

  } catch (err) {
    console.error("刪除留言失敗:", err);
    alert(err.message || "刪除失敗");
  }
}




init();
setInterval(render, 60000);