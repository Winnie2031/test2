let stores = [];
let likedStores = JSON.parse(localStorage.getItem("likedStores")) || [];

const priceMap = {
  1: "NT$100~200",
  2: "NT$200~400",
  3: "NT$400~600",
  4: "NT$600以上",
};

let userPos = null;
let isSending = false;

// =====================
// 距離計算
// =====================
function toRad(deg) {
  return (deg * Math.PI) / 180;
}

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

// =====================
// 照片
// =====================
function photoUrl(photo_reference, opts = {}) {
  if (!photo_reference) return null;
  const maxwidth = opts.maxwidth ?? 800;
  return `/api/photo/${encodeURIComponent(photo_reference)}?maxwidth=${maxwidth}`;
}

// =====================
// 營業時間判斷
// =====================
function timeToMinutes(timeStr) {
  if (!timeStr) return null;

  const hour = parseInt(timeStr.slice(0, 2), 10);
  const minute = parseInt(timeStr.slice(2, 4), 10);

  return hour * 60 + minute;
}

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

  if (!data.periods || !Array.isArray(data.periods)) {
    return null;
  }

  const now = new Date();

  // JS 星期：星期日=0，星期一=1，星期二=2...
  const today = now.getDay();

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // 判斷今天開、今天關，例如 09:00 - 13:00
  for (const period of data.periods) {
    if (!period.open) continue;
    if (period.open.day !== today) continue;

    const openMinutes = timeToMinutes(period.open.time);
    if (openMinutes === null) continue;

    // Google 有些 24 小時營業可能沒有 close
    if (!period.close) {
      return true;
    }

    const closeMinutes = timeToMinutes(period.close.time);
    const closeDay = period.close.day;

    if (closeMinutes === null) continue;

    // 同一天營業
    if (closeDay === today) {
      if (nowMinutes >= openMinutes && nowMinutes < closeMinutes) {
        return true;
      }
    }

    // 跨日營業，例如 今天 18:00 到明天 02:00
    if (closeDay !== today) {
      if (nowMinutes >= openMinutes) {
        return true;
      }
    }
  }

  // 判斷昨天開、今天凌晨關，例如 昨天 18:00 到今天 02:00
  const yesterday = (today + 6) % 7;

  for (const period of data.periods) {
    if (!period.open || !period.close) continue;

    if (period.open.day === yesterday && period.close.day === today) {
      const closeMinutes = timeToMinutes(period.close.time);

      if (closeMinutes !== null && nowMinutes < closeMinutes) {
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

  return `<p class="open-status unknown">⚪ 營業時間未知</p>`;
}

// =====================
// 主渲染
// =====================
function render() {
  const keyword = (document.getElementById("search")?.value || "").trim();
  const container = document.getElementById("cards");
  if (!container) return;

  container.innerHTML = "";

  stores
    .filter((s) => {
      if (!keyword) return true;
      return (
        (s.name || "").includes(keyword) ||
        (s.address || "").includes(keyword)
      );
    })
    .sort((a, b) => {
      // ❤️ 1. 愛心優先
      const aLiked = likedStores.includes(a.id) ? 1 : 0;
      const bLiked = likedStores.includes(b.id) ? 1 : 0;
      if (bLiked !== aLiked) return bLiked - aLiked;

      // 🟢 2. 營業狀態排序（營業中 > 休息 > 未知）
      function openScore(s) {
        if (s === true) return 2;   // 營業中
        if (s === false) return 1;  // 休息中
        return 0;                   // 未知
      }

      const aOpen = isOpenNow(a.opening_hours_json);
      const bOpen = isOpenNow(b.opening_hours_json);

      const aScore = openScore(aOpen);
      const bScore = openScore(bOpen);

      if (bScore !== aScore) return bScore - aScore;

      // 📏 3. 距離（越近越前）
      if (userPos) {
        const aDist =
          a.lat && a.lng
            ? distanceMeters(userPos.lat, userPos.lng, Number(a.lat), Number(a.lng))
            : Infinity;

        const bDist =
          b.lat && b.lng
            ? distanceMeters(userPos.lat, userPos.lng, Number(b.lat), Number(b.lng))
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
        photoUrl(store.photo_reference, { maxwidth: 800 }) ||
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
        <div class="heart">${isLiked ? "❤️" : "🤍"}</div>

        <img src="${img}" alt="${store.name || ""}" loading="lazy">

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

      card.querySelector(".heart").onclick = (e) => {
        e.stopPropagation();

        if (likedStores.includes(store.id)) {
          likedStores = likedStores.filter((id) => id !== store.id);
        } else {
          likedStores.push(store.id);
        }

        localStorage.setItem("likedStores", JSON.stringify(likedStores));
        render();
      };

      container.appendChild(card);
    });
}

// =====================
// 載入餐廳資料
// =====================
async function loadStores() {
  try {
    const res = await fetch("/api/restaurants?limit=60");
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
}

document.getElementById("search")?.addEventListener("input", render);

loadStores();
getUserLocation();

// 每 1 分鐘重新判斷一次營業狀態
setInterval(render, 60000);

// =====================
// AI 聊天功能
// =====================
const aiBtn = document.getElementById("aiBtn");
const aiChat = document.getElementById("aiChat");
const aiInput = document.getElementById("aiInput");
const aiSend = document.getElementById("aiSend");
const aiOutput = document.getElementById("aiOutput");

const MAX_HISTORY = 5;
let chatHistory = [];

if (aiBtn && aiChat) {
  aiBtn.onclick = () => {
    aiChat.style.display =
      aiChat.style.display === "none" ? "block" : "none";
  };
}

async function sendAiMessage() {
  if (isSending) return;
  if (!aiInput || !aiSend || !aiOutput) return;

  const question = aiInput.value.trim();
  if (!question) return;

  isSending = true;

  aiSend.disabled = true;
  aiSend.textContent = "思考中...";

  aiOutput.innerHTML += `<p><strong>你：</strong>${escapeHtml(question)}</p>`;

  aiInput.value = "";

  chatHistory.push({ role: "user", content: question });

  if (chatHistory.length > MAX_HISTORY) {
    chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY);
  }

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: chatHistory }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || `連線失敗，錯誤碼：${res.status}`);
    }

    const data = await res.json();

    chatHistory.push({ role: "assistant", content: data.reply });

    aiOutput.innerHTML += `
      <p><strong>🤖 AI：</strong>${escapeHtml(data.reply)}</p>
      <hr>
    `;
  } catch (err) {
    console.error("前端抓到錯誤：", err);

    aiOutput.innerHTML += `
      <p style="color: #e53e3e;">⚠️ ${err.message}</p>
      <hr>
    `;

    chatHistory.pop();
  } finally {
    isSending = false;

    aiSend.disabled = false;
    aiSend.textContent = "送出";

    aiOutput.scrollTop = aiOutput.scrollHeight;
  }
}

// 防止 XSS
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

// =====================
// GPT 推薦功能
// =====================
async function askGPT() {
  const input = document.getElementById("gptInput");
  const result = document.getElementById("gptResult");

  if (!input || !result) return;

  const message = input.value;

  const res = await fetch("/api/gpt/recommend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const data = await res.json();

  result.innerText =
    data.reply || data.error || JSON.stringify(data, null, 2);
}