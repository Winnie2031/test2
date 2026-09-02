let currentCategories = [];
let currentPriceLevels = [];
let stores = [];
let likedStores = [];
let randomStores = [];
let currentConversationId = null; 

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
    : data.periods;

  if (!Array.isArray(periods)) {
    return null;
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

function getOpenStatusHtml(store) {
  const openStatus = isOpenNow(store.opening_hours_json);

  if (openStatus === true) {
    return `<p class="open-status open">🟢 營業中</p>`;
  }

  if (openStatus === false) {
    return `<p class="open-status closed">🔴 休息中</p>`;
  }

  if (store.business_status === "CLOSED_TEMPORARILY") {
    return `<p class="open-status closed">🟡 暫時停業</p>`;
  }

  if (store.business_status === "CLOSED_PERMANENTLY") {
    return `<p class="open-status closed">🔴 永久停業</p>`;
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



document
  .querySelectorAll(".category-btn:not(#moreBtn)")
  .forEach(btn => {

    btn.addEventListener("click", () => {

      let tag = btn.textContent
        .replace(/[^\u4e00-\u9fa5]/g,"")
        .trim();

      randomStores = [];

      // 全部
      if(tag==="全部"){

        currentCategories=[];

        document
          .querySelectorAll(".category-btn")
          .forEach(b=>b.classList.remove("active"));

        btn.classList.add("active");

        render();
        return;
      }

      // 全部取消
      document
        .querySelectorAll(".category-btn")
        .forEach(b=>{
          if(b.dataset.category==="all"){
            b.classList.remove("active");
          }
        });

      if(currentCategories.includes(tag)){

        currentCategories =
          currentCategories.filter(t=>t!==tag);

        btn.classList.remove("active");

      }else{

        currentCategories.push(tag);

        btn.classList.add("active");

      }

      // 如果沒有任何標籤，自動回到全部
      if(currentCategories.length===0){

        document
          .querySelector('[data-category="all"]')
          ?.classList.add("active");

      }

      render();

    });

});

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
      aiChat.style.display === "none" ? "block" : "none";
  };
}

async function sendAiMessage() {
  // 防呆機制：避免重複發送
  if (isSending) return;
  if (!aiInput || !aiSend || !aiOutput) return;

  const question = aiInput.value.trim();
  if (!question) return;

  // ==========================================
  // 1. 關鍵字分類陣列 (支援內用、外帶、外送)
  // ==========================================
  const foodTypes = [
    "飲料", "早餐", "午餐", "晚餐", "宵夜", "早午餐", "咖啡", "茶",
    "火鍋", "拉麵", "燒肉", "便當", "義大利麵", "牛排", "壽司", "韓式", 
    "日式", "中式", "甜點", "蛋糕", "炸雞", "漢堡", "披薩", 
    "小吃", "滷味", "麵", "飯", "水餃"
  ];

  const timeKeywords = ["營業", "開嗎", "幾點", "關門", "現在"];
  const dineInKeywords = ["內用", "聚餐", "約會", "多人", "單人", "慶生", "聊天"];
  const takeoutKeywords = ["外帶", "帶走", "自取"];
  const deliveryKeywords = ["外送", "送到", "外賣", "叫車"];

  const otherKeywords = [
    "餐廳", "美食", "推薦", "吃", "早餐", "午餐", "晚餐", "宵夜", "飲料", "咖啡",
    "中原", "夜市", "附近", "哪裡", "價格", "價位", "多少", "便宜", "貴", "平價", 
    "預算", "cp值", "划算", "停車", "冷氣", "安靜", "環境", "素食", "辣", "不辣", 
    "健康", "其他", "特色", "口味", "評價", "人氣", "熱門", "排隊", "座位", 
    "位置", "交通", "方便", "舒適"
  ];

  // 合併陣列作初步攔截
  const allKeywords = [
    ...foodTypes, ...timeKeywords, ...dineInKeywords, 
    ...takeoutKeywords, ...deliveryKeywords, ...otherKeywords
  ];

  const storeNames = stores.map(s => s.name).filter(Boolean);
  const mentionsStoreName = storeNames.some(name => question.includes(name));

  const isRestaurantQuestion = mentionsStoreName || allKeywords.some((keyword) =>
    question.includes(keyword)
  );

  if (!isRestaurantQuestion) {
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

  // ==========================================
  // 2. 更新 UI 狀態為發送中 
  // ==========================================
  isSending = true;
  aiSend.disabled = true;
  aiSend.textContent = "思考中...";

  // 🌟 強制重置對話 ID 與星星狀態，確保在資料庫中存為獨立新紀錄
  currentConversationId = null;
  currentConversationIsFavorite = false;

  // 隱藏頂部原本的舊星星 (如果有殘留的話)
  const topStar = document.getElementById('aiActiveStarBtn');
  if (topStar) {
    topStar.style.display = 'none'; 
  }

  // 產生一個暫時的 ID 來定位這組對話
  const msgId = "msg_" + Date.now(); 
  
  // 🌟 重新排版：將使用者的提問放在左邊，預留右邊放星星的空間
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

  // 3. 前端預篩選邏輯 (節省 Token)
  const requiresOpen = timeKeywords.some(keyword => question.includes(keyword));
  const requiresDineIn = dineInKeywords.some(keyword => question.includes(keyword)); 
  const requiresTakeout = takeoutKeywords.some(keyword => question.includes(keyword)); 
  const requiresDelivery = deliveryKeywords.some(keyword => question.includes(keyword)); 
  const matchedFoods = foodTypes.filter(food => question.includes(food));

  const mentionedStores = stores.filter(s => s.name && question.includes(s.name));

  let candidateStores = [];

  if (mentionedStores.length > 0) {
    candidateStores = mentionedStores;
  } else {
    candidateStores = stores.filter(s => {
      if (requiresOpen && isOpenNow(s.opening_hours_json) !== true) return false;
      if (requiresDineIn && !s.dine_in) return false;
      if (requiresTakeout && !s.takeout) return false;
      if (requiresDelivery && !s.delivery) return false;
      
      // 檢查店名、檢查標籤、檢查分類關聯
      if (matchedFoods.length > 0) {
        const hasFoodKeyword = matchedFoods.some(food => {
          // 1. 檢查店名是否包含
          const inName = (s.name || "").includes(food);
          
          // 2. 檢查資料庫標籤 (tags) 是否包含
          const inTags = Array.isArray(s.tags) ? s.tags.includes(food) : String(s.tags || "").includes(food);
          
          // 3. 透過你寫好的 categoryMap 進行深度比對 (例如打'飲料'，會自動比對'茶'、'50嵐'等)
          let inCategory = false;
          if (categoryMap[food]) {
            inCategory = categoryMap[food].some(kw => 
              (s.name || "").includes(kw) || 
              (Array.isArray(s.tags) ? s.tags.includes(kw) : String(s.tags || "").includes(kw))
            );
          }

          return inName || inTags || inCategory;
        });
        
        if (!hasFoodKeyword) return false;
      }
      
      return true;
    });

    // 改為：超過 15 家則隨機取 15 家，讓 AI 有足夠的選項推薦 3~5 家
    if (candidateStores.length > 15) {
      candidateStores = candidateStores.sort(() => 0.5 - Math.random()).slice(0, 15);
    }
  }

  // 如果找不到餐廳，直接回復並恢復 UI 狀態 (不打 API)
  if (candidateStores.length === 0) {
    const replyContainer = document.getElementById(`reply_${msgId}`);
    if (replyContainer) {
       replyContainer.innerHTML = `<p style="color:#ff5722; margin: 0;">🤖 AI：抱歉，目前沒有找到符合的餐廳。</p>`;
    }
    isSending = false;
    aiSend.disabled = false;
    aiSend.textContent = "送出";
    if (aiChat) aiChat.scrollTop = aiChat.scrollHeight;
    return; 
  }

// 4. 打包資料與請求後端 AI
  const contextStores = candidateStores.map(s => {
    const isOp = isOpenNow(s.opening_hours_json);
    const openStr = isOp === true ? "是" : (isOp === false ? "否" : "未知");
    const dineInStr = s.dine_in ? "可" : "不可";
    const takeoutStr = s.takeout ? "可" : "不可";
    const deliveryStr = s.delivery ? "可" : "不可";
    
    const tagStr = Array.isArray(s.tags) && s.tags.length > 0 ? s.tags.join("、") : "無";

    return `名稱:${s.name},標籤:${tagStr},評分:${s.rating || '無'},內用:${dineInStr},外帶:${takeoutStr},外送:${deliveryStr},營業中:${openStr}`;
  }).join(" | ");

  // 🗑️ (這裡原本組裝 enhancedPrompt 的地方已經被刪除了)

  try {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch("/api/gpt", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        question: question,            // ✨ 只傳送乾淨的使用者提問
        contextStores: contextStores,  // ✨ 傳送過濾後的餐廳資料給後端當參考
        conversationId: currentConversationId 
      }),
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    let replyText = data.reply;
    let recommendedName = "";

    const searchCommandRegex = /<<<SEARCH:(.*?)>>>/;
    const match = replyText.match(searchCommandRegex);
    if (match && match[1]) {
      recommendedName = match[1].trim();
      replyText = replyText.replace(searchCommandRegex, "").trim();
    }

    // 🌟 1. 將專屬的星星按鈕填入剛剛預留的空間 (帶入後端產生的 conversationId)
    const starContainer = document.getElementById(`star_${msgId}`);
    if (starContainer && data.conversationId) {
      starContainer.innerHTML = `<button onclick="toggleAiFavorite(${data.conversationId}, false, this)" style="background:none; border:none; font-size: 1.3rem; cursor: pointer; color: #ccc;" title="加入收藏">☆</button>`;
    }

    // 🌟 2. 將 AI 的回答填入剛剛顯示「思考中...」的空間
    const replyContainer = document.getElementById(`reply_${msgId}`);
    if (replyContainer) {
      replyContainer.innerHTML = `<p style="margin: 0; color: #333;"><strong>🤖 AI：</strong>${escapeHtml(replyText)}</p>`;
      
      // 填入搜尋欄並觸發畫面渲染
      // 擷取並觸發主畫面渲染
      if (recommendedName) {
        // 1. 將 AI 輸出的「餐廳A|餐廳B|餐廳C」切分成陣列
        const targetNames = recommendedName.split("|").map(n => n.trim()).filter(Boolean);

        // 2. 利用 randomStores 作為暫存容器，強制主畫面過濾出這幾家店
        randomStores = stores.filter(store =>
          targetNames.some(name => (store.name || "").includes(name))
        );

        // 3. 清空原本的搜尋框，避免上方文字干擾卡片顯示條件
        const searchInput = document.getElementById("search");
        if (searchInput) {
          searchInput.value = "";
        }

        // 4. 重新渲染主畫面卡片
        render();

        // 5. 在聊天室印出綠色的成功提示字樣
        const displayNames = targetNames.join("、");
        replyContainer.innerHTML += `<p style="color: #1f9d55; font-size: 0.85rem; margin-top: 6px; margin-bottom: 0;">✅ 已在主畫面為您列出：<strong>${escapeHtml(displayNames)}</strong></p>`;

        // 🌟 貼心加碼：讓原本隱藏的「🗑️ 復原按鈕」顯示出來！
        const resetRandomBtn = document.getElementById("resetRandomBtn");
        if (resetRandomBtn) {
          resetRandomBtn.style.display = "flex";
        }
      }
    }

  } catch (err) {
    console.error(err);
    const replyContainer = document.getElementById(`reply_${msgId}`);
    if (replyContainer) {
      replyContainer.innerHTML = `<p style="color:red; margin: 0;">AI 回應失敗</p>`;
    }
  }

  // 5. 恢復 UI 狀態並捲動到底部
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

  const userIcon =
    document.getElementById("userIcon");

  const loginItemBtn =
    document.getElementById("loginItemBtn");

  const editUserItemBtn =
    document.getElementById("editUserItemBtn");

  const token =
    localStorage.getItem("token");

  const username =
    localStorage.getItem("username");

  const nickname =
    localStorage.getItem("nickname");

  const displayName =
    nickname || username || "使用者";


  // ===============================
  // 👤 右上角頭像
  // ===============================

  if (userIcon) {

    userIcon.onclick = null;

    if (token) {

      const initial =
        displayName
          .charAt(0)
          .toUpperCase();

      userIcon.innerHTML = initial;
      userIcon.style.fontWeight = "bold";

    } else {

      userIcon.innerHTML = "👤";

    }
  }


  // ===============================
  // 🔐 已登入
  // ===============================

  if (token) {

    if (loginItemBtn) {

      loginItemBtn.innerHTML =
        `🚪 登出 (${displayName})`;

      loginItemBtn.onclick =
        handleLogout;
    }


    // 顯示「編輯使用者」
    if (editUserItemBtn) {

      editUserItemBtn.style.display =
        "flex";
    }


  // ===============================
  // 🔓 未登入
  // ===============================

  } else {

    if (loginItemBtn) {

      loginItemBtn.innerHTML =
        `🔑 登入 / 會員中心`;

      loginItemBtn.onclick =
        openLoginModal;
    }


    // 隱藏「編輯使用者」
    if (editUserItemBtn) {

      editUserItemBtn.style.display =
        "none";
    }
  }
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

// ==================== AI 歷史紀錄功能 ====================
const aiHistoryBtn = document.getElementById("aiHistoryBtn");
const aiHistoryModal = document.getElementById("aiHistoryModal");

if (aiHistoryBtn) {
  aiHistoryBtn.onclick = () => {
    const token = getToken();
    if (!token) {
      alert("請先登入才能查看歷史紀錄喔！");
      switchToLogin();
      return;
    }
    if (aiHistoryModal) {
      aiHistoryModal.style.display = 'flex';
      loadAiHistories(); 
    }
  };
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

// 5. 載入單一對話的詳細內容 (加入頂部星星狀態顯示)
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
      currentConversationIsFavorite = isFavorite; // 更新全域變數
      
      const modal = document.getElementById('aiHistoryModal');
      if (modal) modal.style.display = 'none';

      const aiChat = document.getElementById("aiChat");
      if (aiChat) aiChat.style.display = "block";

      // 顯示聊天室頂部的星星，並依照狀態變色
      const topStar = document.getElementById('aiActiveStarBtn');
      if (topStar) {
        topStar.style.display = 'inline-block';
        topStar.style.color = isFavorite ? '#ffc107' : '#ccc';
        topStar.innerText = isFavorite ? '⭐' : '☆';
      }

      if (aiOutput) {
        aiOutput.innerHTML = '';
        data.data.forEach(msg => {
          if (msg.role === 'user') {
            aiOutput.innerHTML += `<p><strong>你：</strong>${escapeHtml(msg.content)}</p>`;
          } else {
            let cleanText = msg.content.replace(/<<<SEARCH:(.*?)>>>/, "").trim();
            aiOutput.innerHTML += `<p><strong>🤖 AI：</strong>${escapeHtml(cleanText)}</p><hr>`;
          }
        });
      }
      if (aiChat) aiChat.scrollTop = aiChat.scrollHeight;
    }
  } catch (err) {
    console.error("讀取對話失敗", err);
  }
}
// ===============================================================

// ==================== 懸浮視窗控制功能 ====================

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

let moreOpen = false;

function toggleMoreTags() {

    moreOpen = !moreOpen;

    const tags = document.querySelectorAll(".more-tag");
    const btn = document.getElementById("moreBtn");

    tags.forEach(tag=>{
        tag.classList.toggle("show", moreOpen);
    });

    btn.textContent = moreOpen ? "➖ 收起" : "➕ 更多";
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


// ==================== 1. 開啟好友視窗 ====================
function openFriendsModal() {
  openUserPanel("friends");
}


// ==================== 2. 關閉好友視窗 ====================
function closeFriendsModal() {
  const modal = document.getElementById("friendsModal");

  if (modal) {
    modal.classList.remove("active");
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

async function loadFeedFriendAvatars() {

  const container =
    document.getElementById(
      "feedFriendAvatars"
    );

  if (!container) return;

  const token = getToken();

  if (!token) {
    container.innerHTML = "";
    return;
  }

  try {

    const res = await fetch(
      "/api/friends",
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "載入好友失敗"
      );
    }

    const friends =
      data.friends || [];


    // 第一個：全部動態
    let html = `
      <div
        class="
          feed-friend-avatar-item
          active
        "
        onclick="
          showAllFriendFeeds(this)
        "
      >

        <div
          class="
            feed-friend-avatar-circle
            feed-all-avatar-circle
          "
        >
          👥
        </div>

        <div
          class="feed-friend-avatar-name"
        >
          全部
        </div>

      </div>
    `;


    // 每個好友
    html += friends.map(friend => {

      const nickname =
        friend.nickname ||
        "好友";

      const initial =
        nickname
          .charAt(0)
          .toUpperCase();

      return `
        <div
          class="feed-friend-avatar-item"

          onclick="
            selectFriendFeed(
              ${friend.user_id},
              '${escapeJsString(nickname)}',
              this
            )
          "
        >

          <div
            class="feed-friend-avatar-circle"
          >
            ${escapeHtml(initial)}
          </div>

          <div
            class="feed-friend-avatar-name"
          >
            ${escapeHtml(nickname)}
          </div>

        </div>
      `;

    }).join("");


    container.innerHTML = html;

  } catch (err) {

    console.error(
      "載入好友頭像失敗:",
      err
    );

    container.innerHTML = "";
  }
}

// ============================================================
// 👤 點好友頭像
// ============================================================

async function selectFriendFeed(
  userId,
  nickname,
  element
) {

  document
    .querySelectorAll(
      ".feed-friend-avatar-item"
    )
    .forEach(item => {
      item.classList.remove("active");
    });

  element?.classList.add("active");


  // 你原本就有這個功能
  await openUserProfile(
    userId,
    nickname
  );
}


// ============================================================
// 👥 顯示全部好友動態
// ============================================================

async function showAllFriendFeeds(
  element
) {

  document
    .querySelectorAll(
      ".feed-friend-avatar-item"
    )
    .forEach(item => {
      item.classList.remove("active");
    });

  element?.classList.add("active");

  await loadFriendFeeds();
}

async function loadFriendFeeds() {
  const container =
    document.getElementById("friendFeedList");

  if (!container) return;

  const token = getToken();

  if (!token) {
    container.innerHTML =
      '<p class="empty-msg">請先登入才能查看好友動態</p>';
    return;
  }

  container.innerHTML =
    '<p class="empty-msg">動態載入中...</p>';

  try {
    const res = await fetch(
      "/api/friends/posts/feed",
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

console.log("🔥 好友動態 API 回傳：", data);
console.log("🔥 第一篇貼文：", data.posts?.[0]);
console.log("🔥 第一篇圖片陣列：", data.posts?.[0]?.images);
console.log("🔥 是不是陣列：", Array.isArray(data.posts?.[0]?.images));

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "無法取得好友動態"
      );
    }

    if (
      !data.posts ||
      data.posts.length === 0
    ) {
      container.innerHTML =
        '<p class="empty-msg">目前沒有好友動態，快去新增好友吧！ 📸</p>';
      return;
    }

    container.innerHTML =
      data.posts.map(post => {

        const displayName =
          post.nickname ||
          post.username ||
          "使用者";

        const avatarText =
          displayName
            .charAt(0)
            .toUpperCase();

        const timeText =
          post.created_at
            ? new Date(
                post.created_at
              ).toLocaleString(
                "zh-TW"
              )
            : "";

        return `
          <div class="feed-card">

            <!-- =========================
                 頭貼 + 名稱
            ========================== -->
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
    post.is_owner
      ? `
        <button
          type="button"
          class="post-delete-btn"
          onclick="deletePost(${post.post_id})"
          title="刪除貼文"
        >
          🗑️
        </button>
      `
      : ""
  }

</div>

            <!-- =========================
                 貼文內容
            ========================== -->

            <div class="feed-body">

              <!-- 文字 -->
              ${
                post.content
                  ? `
                    <p class="feed-caption">
                      ${escapeHtml(
                        post.content
                      )}
                    </p>
                  `
                  : ""
              }


              <!-- 照片 -->
              ${
                Array.isArray(post.images) &&
                post.images.length > 0
                  ? `
                    <div class="feed-carousel">

                      <div
                        class="feed-carousel-track"
                        onscroll="updateCarouselDots(this)"
                      >

                        ${post.images.map((imageUrl, index) => `
                          <div class="feed-carousel-slide">

                            <img
                              src="${imageUrl}"
                              class="feed-carousel-image"
                              alt="貼文照片 ${index + 1}"
                              loading="lazy"
                            >

                          </div>
                        `).join("")}

                      </div>


                      ${
                        post.images.length > 1
                          ? `
                            <div class="feed-carousel-count">
                              1 / ${post.images.length}
                            </div>

                            <div class="feed-carousel-dots">

                              ${post.images.map((_, index) => `
                                <span
                                  class="feed-carousel-dot ${index === 0 ? "active" : ""}"
                                ></span>
                              `).join("")}

                            </div>
                          `
                          : ""
                      }

                    </div>
                  `
                  : ""
              }


              <!-- 地點 -->
              ${
                post.restaurant_id &&
                post.restaurant_name
                  ? `
                    <div
                      class="feed-restaurant"
                      onclick="
                        window.location.href=
                        'detail.html?id=${post.restaurant_id}'
                      "
                    >
                      📍 ${escapeHtml(
                        post.restaurant_name
                      )}
                    </div>
                  `
                  : ""
              }

              <!-- =========================
     ❤️ 按讚 + 💬 留言
========================== -->

<div class="feed-actions">

  <button
    type="button"
    class="feed-like-btn ${post.liked_by_me ? "liked" : ""}"
    onclick="togglePostLike(${post.post_id}, this)"
    title="按讚"
  >
    <span class="heart-icon">
      ${post.liked_by_me ? "♥" : "♡"}
    </span>
  </button>

  <button
  type="button"
  class="feed-comment-btn"
  onclick="togglePostComments(${post.post_id})"
  title="留言"
>
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8
             8.5 8.5 0 0 1-7.6 4.7
             8.4 8.4 0 0 1-3.8-.9
             L3 21l1.9-5.7
             a8.4 8.4 0 0 1-.9-3.8
             8.5 8.5 0 0 1 4.7-7.6
             8.4 8.4 0 0 1 3.8-.9
             h.5
             a8.5 8.5 0 0 1 8 8
             v.5z">
    </path>
  </svg>
</button>

</div>


<!-- 讚數 -->
<div
  class="feed-like-count"
  id="likeCount-${post.post_id}"
>
  ${
    Number(post.like_count || 0) > 0
      ? `${Number(post.like_count)} 個讚`
      : ""
  }
</div>


<!-- 留言區 -->
<div
  class="post-comments-area"
  id="commentsArea-${post.post_id}"
>

  ${
    Number(post.comment_count || 0) > 0
      ? `
        <button
          type="button"
          class="view-comments-btn"
          id="viewCommentsBtn-${post.post_id}"
          onclick="togglePostComments(${post.post_id})"
        >
          查看全部 ${Number(post.comment_count)} 則留言
        </button>
      `
      : ""
  }


  <div
    class="post-comments-list"
    id="commentsList-${post.post_id}"
    style="display:none;"
  ></div>


  <div
    class="post-comment-form"
    id="commentForm-${post.post_id}"
    style="display:none;"
  >

    <input
      type="text"
      id="commentInput-${post.post_id}"
      class="post-comment-input"
      maxlength="300"
      placeholder="新增留言……"
      onkeydown="
        if(event.key === 'Enter') {
          submitPostComment(${post.post_id});
        }
      "
    >

    <button
      type="button"
      class="post-comment-submit"
      onclick="submitPostComment(${post.post_id})"
    >
      發布
    </button>

  </div>

</div>


              <!-- 時間 -->
              <div class="feed-bottom-time">
                ${escapeHtml(timeText)}
              </div>

            </div>

          </div>
        `;

      }).join("");

  } catch (err) {

    console.error(
      "載入好友動態失敗:",
      err
    );

    container.innerHTML = `
      <p
        class="empty-msg"
        style="color:#e53e3e;"
      >
        ${escapeHtml(err.message)}
      </p>
    `;
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

async function togglePostComments(postId) {

  const list =
    document.getElementById(
      `commentsList-${postId}`
    );

  const form =
    document.getElementById(
      `commentForm-${postId}`
    );

  if (!list || !form) return;


  // 已經打開 → 收起來
  if (list.style.display !== "none") {

    list.style.display = "none";
    form.style.display = "none";

    return;
  }


  list.style.display = "block";
  form.style.display = "flex";

  list.innerHTML =
    `<div class="comments-loading">
       留言載入中...
     </div>`;


  try {

    const res = await fetch(
      `/api/posts/${postId}/comments`,
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {

      throw new Error(
        data.error || "取得留言失敗"
      );
    }


    renderPostComments(
      postId,
      data.comments || []
    );

  } catch (err) {

    console.error(
      "取得留言失敗:",
      err
    );

    list.innerHTML = `
      <div class="comments-error">
        ${escapeHtml(err.message)}
      </div>
    `;
  }
}
function renderPostComments(
  postId,
  comments
) {

  const list =
    document.getElementById(
      `commentsList-${postId}`
    );

  if (!list) return;


  if (!comments.length) {

    list.innerHTML = `
      <div class="no-comments">
        還沒有留言
      </div>
    `;

    return;
  }


  list.innerHTML =
    comments.map(comment => {

      const nickname =
        comment.nickname ||
        comment.student_id ||
        "使用者";

      return `
        <div class="post-comment">

          <span class="post-comment-name">
            ${escapeHtml(nickname)}
          </span>

          <span class="post-comment-content">
            ${escapeHtml(comment.content)}
          </span>

        </div>
      `;

    }).join("");
}
// ============================================================
// 💬 發布留言
// ============================================================

async function submitPostComment(postId) {

  const input =
    document.getElementById(
      `commentInput-${postId}`
    );

  if (!input) return;

  const content =
    input.value.trim();

  if (!content) return;


  try {

    const res = await fetch(
      `/api/posts/${postId}/comments`,
      {
        method: "POST",

        headers:
          getAuthHeaders(true),

        body: JSON.stringify({
          content
        })
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {

      throw new Error(
        data.error || "留言失敗"
      );
    }


    // 清空輸入框
    input.value = "";


    // 重新抓留言
    const commentsRes = await fetch(
      `/api/posts/${postId}/comments`,
      {
        headers: getAuthHeaders()
      }
    );

    const commentsData =
      await commentsRes.json();

    if (
      commentsRes.ok &&
      commentsData.ok
    ) {

      renderPostComments(
        postId,
        commentsData.comments || []
      );


      // 更新「查看全部 X 則留言」
      const viewBtn =
        document.getElementById(
          `viewCommentsBtn-${postId}`
        );

      if (viewBtn) {

        viewBtn.textContent =
          `查看全部 ${
            commentsData.comments.length
          } 則留言`;
      }
    }

  } catch (err) {

    console.error(
      "留言失敗:",
      err
    );

    alert(
      err.message || "留言失敗"
    );
  }
}

// ============================================================
// 🗑️ 永久刪除貼文
// ============================================================
async function deletePost(postId) {
  const token = getToken();

  if (!token) {
    alert("請先登入");
    return;
  }

  const confirmed = confirm(
    "確定要永久刪除這篇貼文嗎？\n刪除後無法復原。"
  );

  if (!confirmed) return;

  try {
    const res = await fetch(
      `/api/posts/${postId}`,
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
        data.error || "刪除貼文失敗"
      );
    }

    await loadFriendFeeds();

  } catch (err) {
    console.error("刪除貼文失敗：", err);

    alert(
      err.message || "刪除貼文失敗"
    );
  }
}


// ==================== 5. 我的好友 ====================
function renderMyFriends(friends) {
  const container =
    document.getElementById("myFriendsList");

  if (!container) return;

  if (!friends || friends.length === 0) {

    container.innerHTML =
      '<p class="empty-msg">目前還沒有好友喔！</p>';

    return;
  }

  container.innerHTML =
    friends.map(friend => {

      const nickname =
        friend.nickname || "中原同學";

      return `
        <div
  class="friend-item"

  onclick="
    handleFriendClick(
      ${friend.user_id},
      '${escapeJsString(nickname)}'
    )
  "

  onpointerdown="
    startFriendLongPress(
      ${friend.friendship_id},
      '${escapeJsString(nickname)}'
    )
  "

  onpointerup="cancelFriendLongPress()"
  onpointerleave="cancelFriendLongPress()"
  onpointercancel="cancelFriendLongPress()"
>

          <div class="friend-avatar">
            👤
          </div>

          <div class="friend-info">

            <span class="friend-name">
              ${escapeHtml(nickname)}
            </span>

            <span class="friend-id">
              學號：
              ${escapeHtml(friend.student_id || "")}
            </span>

          </div>

          <span
            style="
              font-size:0.8rem;
              color:#888;
            "
          >
            查看動態 ❯
          </span>

        </div>
      `;
    }).join("");
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
function handleFriendClick(
  userId,
  nickname
) {
  if (friendLongPressTriggered) {
    friendLongPressTriggered = false;
    return;
  }

  openUserProfile(
    userId,
    nickname
  );
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
  const container =
    document.getElementById("myFriendsList");

  if (!container) return;

  container.innerHTML =
    '<p class="empty-msg">好友載入中...</p>';

  try {

    const res = await fetch(
      "/api/friends",
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "載入好友列表失敗"
      );
    }

    renderMyFriends(data.friends);

  } catch (err) {

    console.error(
      "載入好友列表失敗:",
      err
    );

    container.innerHTML =
      `<p class="empty-msg" style="color:#e53e3e;">
        ${escapeHtml(err.message)}
      </p>`;
  }
}


// ==================== 7. 查看某位好友的貼文 ====================
async function openUserProfile(userId, nickname) {
  const container =
    document.getElementById("friendFeedList");

  if (!container) return;

  // 先切換畫面，但避免呼叫 loadFriendFeeds()
  document
    .querySelectorAll(".friends-tabs .tab-btn")
    .forEach(tab => {
      tab.classList.remove("active");
    });

  document
    .querySelectorAll(".friends-modal-body .tab-content")
    .forEach(content => {
      content.classList.remove("active");
    });

  document
    .getElementById("tab-feed")
    ?.classList.add("active");

  const feedTab =
    document.querySelector(
      `.tab-btn[onclick*="'feed'"]`
    );

  if (feedTab) {
    feedTab.classList.add("active");
  }

  container.innerHTML =
    `<p class="empty-msg">
      正在載入 ${escapeHtml(nickname)} 的動態...
    </p>`;

  try {

    const res = await fetch(
      `/api/friends/posts/user/${userId}`,
      {
        headers: getAuthHeaders()
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "載入好友動態失敗"
      );
    }

    if (!data.posts || data.posts.length === 0) {

      container.innerHTML =
        `<p class="empty-msg">
          ${escapeHtml(nickname)}
          還沒有發過任何動態喔！ 📷
        </p>`;

      return;
    }

    container.innerHTML = `

      <div
        style="
          padding:8px 0;
          font-weight:bold;
          color:#ff5722;
        "
      >
        👤 ${escapeHtml(nickname)}
        的所有動態
        (${data.posts.length})
      </div>

      ${
        data.posts.map(post => `

          <div class="feed-card">

            <div class="feed-header">

              <div class="feed-avatar">
                ${
                  escapeHtml(
                    nickname.charAt(0)
                  )
                }
              </div>

              <div class="feed-user-info">

                <span class="feed-author">
                  ${escapeHtml(nickname)}
                </span>

                <span class="feed-time">
                  ${
                    new Date(
                      post.created_at
                    ).toLocaleString()
                  }
                </span>

              </div>

            </div>

            ${
              post.restaurant_name
                ? `
                  <span class="feed-tag">
                    📍 ${escapeHtml(post.restaurant_name)}
                  </span>
                `
                : ""
            }

            ${
              post.content
                ? `
                  <p class="feed-text">
                    ${escapeHtml(post.content)}
                  </p>
                `
                : ""
            }

            ${
              post.image_url
                ? `
                  <img
                    src="${post.image_url}"
                    class="feed-image"
                    alt="美食照片"
                    loading="lazy"
                  >
                `
                : ""
            }

          </div>

        `).join("")
      }
    `;

  } catch (err) {

    console.error(
      "載入指定好友動態失敗:",
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
    // 邀請等待處理
    // ==============================
    else if (friendshipStatus === "PENDING") {

      buttonHtml = `
        <button
          class="action-btn"
          disabled
          style="
            background:#ccc;
            cursor:not-allowed;
          "
        >
          邀請處理中
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

  const actionContainer =
    document.getElementById(
      `search-action-${targetUserId}`
    );

  try {

    const res = await fetch(
      "/api/friends/request",
      {
        method: "POST",

        headers:
          getAuthHeaders(true),

        body: JSON.stringify({
          targetUserId
        })
      }
    );

    const data = await res.json();

    if (!res.ok || !data.ok) {

      alert(
        data.error ||
        "發送邀請失敗"
      );

      return;
    }

    alert(
      data.message ||
      "好友邀請已成功發送！"
    );

    if (actionContainer) {

      actionContainer.innerHTML = `
        <button
          class="action-btn"
          disabled
          style="
            background:#ccc;
            cursor:not-allowed;
          "
        >
          邀請處理中
        </button>
      `;
    }

  } catch (err) {

    console.error(
      "發送好友邀請失敗:",
      err
    );

    alert(
      "伺服器錯誤，請稍後再試"
    );
  }
}


// ==================== 10. 好友申請畫面 ====================
function renderRequests(requests) {
  const requestsList =
    document.getElementById("requestsList");

  if (!requestsList) return;

  if (!requests || requests.length === 0) {

    requestsList.innerHTML =
      '<p class="empty-msg">目前沒有新的好友申請 ✉️</p>';

    return;
  }

  requestsList.innerHTML =
    requests.map(req => `

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
            學號：
            ${escapeHtml(req.student_id || "")}
          </span>

        </div>

        <div class="btn-group">

          <button
            class="action-btn success"
            onclick="
              respondRequest(
                ${req.friendship_id},
                'ACCEPT'
              )
            "
          >
            同意
          </button>

          <button
            class="action-btn danger"
            onclick="
              respondRequest(
                ${req.friendship_id},
                'REJECT'
              )
            "
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

  const textarea =
    document.getElementById("postContent");

  if (!textarea) return;

  const content =
    textarea.value.trim();

  if (!content) {
    alert("請輸入貼文內容！");
    textarea.focus();
    return;
  }

  if (content.length > 500) {
    alert("貼文最多 500 個字");
    return;
  }

  const publishButton =
    document.querySelector(
      ".publish-post-btn"
    );

  try {

    if (publishButton) {
      publishButton.disabled = true;
      publishButton.textContent =
        "發布中...";
    }

   // 取得選到的圖片
const imageInput =
  document.getElementById("postImageInput");

const imageFiles =
  Array.from(imageInput?.files || []);


// 建立 FormData
const formData =
  new FormData();

formData.append(
  "content",
  content
);


// 有 Tag 餐廳才加
if (selectedPostRestaurant) {
  formData.append(
    "restaurantId",
    selectedPostRestaurant.id
  );
}


// 有選圖片才加
imageFiles.forEach(file => {
  formData.append(
    "images",
    file
  );
});


// 發送給後端
const res = await fetch(
  "/api/posts",
  {
    method: "POST",

    headers: {
      Authorization:
        `Bearer ${token}`
    },

    body: formData
  }
);

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.error || "發布失敗"
      );
    }

    textarea.value = "";

    clearPostRestaurant();

    closeCreatePost();

    await loadFriendFeeds();

  } catch (error) {

    console.error(
      "發布貼文失敗:",
      error
    );

    alert(
      error.message ||
      "發布貼文失敗"
    );

  } finally {

    if (publishButton) {
      publishButton.disabled = false;
      publishButton.textContent =
        "發布";
    }
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


// =====================================================
// 👥 👤 共用使用者視窗切換
// =====================================================

function openUserPanel(type) {

  const token = getToken();

  if (!token) {

    alert("請先登入");

    openLoginModal();

    return;
  }


  const modal =
    document.getElementById(
      "friendsModal"
    );

  const friendsView =
    document.getElementById(
      "userPanelFriends"
    );

  const editView =
    document.getElementById(
      "userPanelEdit"
    );

  const title =
    document.getElementById(
      "userPanelTitle"
    );


  if (!modal) {

    console.error(
      "找不到 friendsModal"
    );

    return;
  }


  modal.classList.add(
    "active"
  );


  // ==============================
  // 好友社群
  // ==============================

  if (type === "friends") {

    if (title) {
      title.textContent =
        "👥 好友社群";
    }


    if (friendsView) {
      friendsView.style.display =
        "block";
    }


    if (editView) {
      editView.style.display =
        "none";
    }


    switchFriendTab(
      "feed"
    );


    return;
  }


  // ==============================
  // 編輯使用者
  // ==============================

  if (type === "edit") {

    if (title) {
      title.textContent =
        "👤 編輯使用者";
    }


    if (friendsView) {
      friendsView.style.display =
        "none";
    }


    if (editView) {
      editView.style.display =
        "block";
    }


    loadCurrentUserProfile();


    return;
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


  const nicknameInput =
    document.getElementById("editUserNickname");

  const phoneInput =
    document.getElementById("editUserPhone");


  const nickname =
    nicknameInput?.value.trim() || "";

  const phone =
    phoneInput?.value.trim() || "";


  // ==============================
  // 暱稱檢查
  // ==============================

  if (!nickname) {
    alert("請輸入暱稱");
    nicknameInput?.focus();
    return;
  }


  if (
    nickname.length < 1 ||
    nickname.length > 20
  ) {
    alert("暱稱必須為 1～20 個字");
    nicknameInput?.focus();
    return;
  }


  // ==============================
  // 手機號碼檢查
  // ==============================

  if (!/^09\d{8}$/.test(phone)) {
    alert("手機號碼必須為 09 開頭的 10 位數字");
    phoneInput?.focus();
    return;
  }


  try {

    const res = await fetch(
      "/api/users/me",
      {
        method: "PUT",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },

        body: JSON.stringify({
          nickname,
          phone
        })
      }
    );


    const data = await res.json();


    if (!res.ok || !data.ok) {
      throw new Error(
        data.error ||
        "儲存失敗"
      );
    }


    // 更新 localStorage
    localStorage.setItem(
      "nickname",
      data.user?.nickname || nickname
    );


    // 更新畫面
    const displayName =
      document.getElementById(
        "editUserDisplayName"
      );

    if (displayName) {
      displayName.textContent =
        data.user?.nickname || nickname;
    }


    const avatar =
      document.getElementById(
        "editUserAvatarCircle"
      );

    if (avatar) {
      avatar.textContent =
        (
          data.user?.nickname ||
          nickname ||
          "使"
        ).charAt(0);
    }


    // 更新右上角使用者顯示
    setupUserIcon();


    alert("✅ 使用者資料已儲存");


    // 再從資料庫讀一次
    await loadCurrentUserProfile();


  } catch (error) {

    console.error(
      "儲存使用者資料失敗：",
      error
    );


    alert(
      "❌ " +
      (
        error.message ||
        "儲存失敗"
      )
    );
  }
}

// =====================================================
// 👤 右上角使用者選單
// 電腦可 hover，手機點一下開 / 再點一下關
// =====================================================

document.addEventListener("DOMContentLoaded", () => {

  const userIcon =
    document.getElementById("userIcon");

  const userDropdown =
    document.querySelector(".user-dropdown-container");

  if (!userIcon || !userDropdown) return;


  // 點 👤：開啟 / 關閉
  userIcon.addEventListener("click", (event) => {

    event.preventDefault();
    event.stopPropagation();

    userDropdown.classList.toggle("active");

  });


  // 點選單裡面，不要因為冒泡立刻關閉
  userDropdown.addEventListener("click", (event) => {
    event.stopPropagation();
  });


  // 點其他地方 → 關閉
  document.addEventListener("click", () => {
    userDropdown.classList.remove("active");
  });

});

init();
setInterval(render, 60000);