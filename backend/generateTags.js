function generateTags(name, types = []) {
  const tags = [];

  if (types.includes("cafe")) tags.push("咖啡");
  if (types.includes("bakery")) tags.push("麵包", "早餐");
  if (types.includes("meal_takeaway")) tags.push("外帶");
  if (types.includes("meal_delivery")) tags.push("外送");

  if (name.includes("早餐") || name.includes("漢堡") || name.includes("弘爺") || name.includes("美而美")) {
    tags.push("早餐");
  }

  if (name.includes("韓") || name.includes("韓式")) {
    tags.push("韓式");
  }

  if (name.includes("火鍋") || name.includes("鍋") || name.includes("三媽")) {
    tags.push("火鍋");
  }

  if (name.includes("拉麵")) tags.push("拉麵");
  if (name.includes("壽司") || name.includes("丼")) tags.push("日式");
  if (name.includes("義大利") || name.includes("義式") || name.includes("披薩")) tags.push("義式");
  if (name.includes("便當") || name.includes("飯")) tags.push("便當");
  if (name.includes("飲料") || name.includes("茶") || name.includes("鮮奶")) tags.push("飲料");
  if (name.includes("雞排") || name.includes("鹽酥雞")) tags.push("炸物");
  if (name.includes("牛排")) tags.push("牛排");
  if (name.includes("甜點") || name.includes("蛋糕")) tags.push("甜點");

  return [...new Set(tags)];
}

module.exports = generateTags;