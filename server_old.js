const express = require("express")
const app = express()
const PORT = 3000

app.use(express.json())

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
  next()
})


const stores = [
  {
    id: 1,
    google_place_id: "ChIJ123456789",
    name: "慕森",
    address: "320桃園市中壢區大仁五街45號",
    lat: 24.9578,
    lng: 121.2257,
    rating: 4.5,
    user_ratings_total: 328,
    price_level: 2,
    opening_now: false,
    business_status: "OPERATIONAL",
    phone: "0903-860-348",
    website: "https://shop.ichefpos.com/store/ztnVbQ6t/reserve?utm_medium=google_map&utm_source=ichef_gbp_reservation",
    google_maps_url: "https://www.google.com/maps/place/%E6%85%95%E6%A3%AEMuSen%EF%BC%88%E4%B8%AD%E5%8E%9F%E6%97%A9%E5%8D%88%E9%A4%90%2F%E4%B8%AD%E5%8E%9F%E7%BE%8E%E9%A3%9F%EF%BC%89%E3%80%8A%E6%8E%A8%E8%96%A6%E6%97%A9%E5%8D%88%E9%A4%90%E3%80%8B%E5%BF%85%E5%90%83%E6%97%A9%E5%8D%88%E9%A4%90%EF%BD%9C%E6%89%8B%E4%BD%9C%EF%BD%9C%E7%B2%BE%E7%B7%BB%EF%BD%9C%E5%AF%B5%E7%89%A9%E5%8F%8B%E5%96%84/@24.9565628,121.2401158,17z/data=!3m1!4b1!4m6!3m5!1s0x3468231637e034cf:0x2a44cbbd16723dd8!8m2!3d24.9565628!4d121.2401158!16s%2Fg%2F11ss3g0582?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: true,
    dine_in: true,
    takeout: true,
    reservable: false,
    wheelchair_accessible_entrance: true,
    details_fetched_at: "2026-02-10T10:00:00Z"
  },
  {
    id: 2,
    google_place_id: "ChIJ987654321",
    name: "Mint Pasta",
    address: "320桃園市中壢區新中北路61號",
    lat: 24.9601,
    lng: 121.2243,
    rating: 4.2,
    user_ratings_total: 210,
    price_level: 3,
    opening_now: false,
    business_status: "OPERATIONAL",
    phone: "03-436-9920",
    website: "https://www.facebook.com/mintpasta9920/",
    google_maps_url: "https://www.google.com/maps/place/Mint+Pasta+%E4%B8%AD%E5%8E%9F%E5%BA%97/@24.9571758,121.2362458,17z/data=!3m1!4b1!4m6!3m5!1s0x34682209b4dcbbb7:0x417c60a85f762615!8m2!3d24.9571758!4d121.2362458!16s%2Fg%2F1pzyqdwwl?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: true,
    dine_in: true,
    takeout: false,
    reservable: true,
    wheelchair_accessible_entrance: false,
    details_fetched_at: "2026-02-10T10:05:00Z"
  },
  {
    id: 3,
    google_place_id: "ChIJ555555555",
    name: "樂野和風洋食屋",
    address: "320桃園市中壢區大仁五街31號",
    lat: 24.9622,
    lng: 121.2275,
    rating: 4.7,
    user_ratings_total: 450,
    price_level: 2,
    opening_now: false,
    business_status: "OPERATIONAL",
    phone: "03-438-3788",
    website: "https://www.facebook.com/profile.php?id=100054537455743",
    google_maps_url: "https://www.google.com/maps/place/%E6%A8%82%E9%87%8E%E5%92%8C%E9%A2%A8%E6%B4%8B%E9%A3%9F%E5%B1%8B2%2F6%EF%BD%9E2%2F21%E4%BC%91%E6%81%AF/@24.9562545,121.2403876,17z/data=!3m1!4b1!4m6!3m5!1s0x3468232e13da8c71:0x651276d476c99d44!8m2!3d24.9562545!4d121.2403876!16s%2Fg%2F11fm5dvws1?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: true,
    dine_in: true,
    takeout: true,
    reservable: true,
    wheelchair_accessible_entrance: true,
    details_fetched_at: "2026-02-10T09:50:00Z"
  },
  {
    id: 4,
    google_place_id: "ChIJ666666666",
    name: "麻久豚食屋",
    address: "320桃園市中壢區大智街8號",
    lat: 24.9555,
    lng: 121.2299,
    rating: 4.0,
    user_ratings_total: 180,
    price_level: 1,
    opening_now: false,
    business_status: "OPERATIONAL",
    phone: "0983-710-219",
    website: "https://www.facebook.com/profile.php?id=100070149488641&mibextid=LQQJ4d",
    google_maps_url: "https://www.google.com/maps/place/%E9%BA%BB%E4%B9%85%E8%B1%9A%E9%A3%9F%E5%B1%8B/@24.9546936,121.2407085,17z/data=!4m6!3m5!1s0x3468238fbfebc6b9:0x70867f341c17db07!8m2!3d24.953171!4d121.241138!16s%2Fg%2F11tn7g7380?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: true,
    dine_in: true,
    takeout: true,
    reservable: true,
    wheelchair_accessible_entrance: false,
    details_fetched_at: "2026-02-09T18:00:00Z"
  },
  {
    id: 5,
    google_place_id: "ChIJ777777777",
    name: "饗越食堂",
    address: "320桃園市中壢區大仁二街29號1樓",
    lat: 24.9599,
    lng: 121.2233,
    rating: 4.8,
    user_ratings_total: 500,
    price_level: 3,
    opening_now: true,
    business_status: "OPERATIONAL",
    phone: "0900-146-876",
    website: "",
    google_maps_url: "https://www.google.com/maps/place/%E9%A5%97%E8%B6%8A%E9%A3%9F%E5%A0%82/@24.9561408,121.240106,16.75z/data=!3m1!5s0x346822151d5e0019:0x8582c4931940bb84!4m6!3m5!1s0x3468237636389155:0x512ad3d6ea8fc066!8m2!3d24.9548963!4d121.2422643!16s%2Fg%2F11t2s9_ht5?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: false,
    dine_in: true,
    takeout: true,
    reservable: true,
    wheelchair_accessible_entrance: true,
    details_fetched_at: "2026-02-10T11:00:00Z"
  },
  {
    id: 6,
    google_place_id: "ChIJ888888888",
    name: "Plan Bee小蜜蜂手工豆花",
    address: "320桃園市中壢區新中北路452號",
    lat: 24.9588,
    lng: 121.2266,
    rating: 4.3,
    user_ratings_total: 210,
    price_level: 2,
    opening_now: false,
    business_status: "OPERATIONAL",
    phone: "034515915",
    website: "https://www.facebook.com/PlanBee452/",
    google_maps_url: "https://www.google.com/maps/place/Plan+Bee%E5%B0%8F%E8%9C%9C%E8%9C%82%E6%89%8B%E5%B7%A5%E8%B1%86%E8%8A%B1/@24.9560335,121.2398436,16.5z/data=!4m6!3m5!1s0x34682216a4f58d77:0xebd115ea4af3add0!8m2!3d24.9581997!4d121.2444535!16s%2Fg%2F11ddzfmrty?entry=ttu&g_ep=EgoyMDI2MDIwNC4wIKXMDSoASAFQAw%3D%3D",
    delivery: true,
    dine_in: true,
    takeout: true,
    reservable: false,
    wheelchair_accessible_entrance: true,
    details_fetched_at: "2026-02-09T14:30:00Z"
  }
]


// 👉 所有餐廳
app.get("/stores", (req, res) => {
  res.json(stores)
})

// 👉 單一家
app.get("/stores/:id", (req, res) => {
  const id = Number(req.params.id)
  const store = stores.find(s => s.id === id)
  res.json(store)
})

app.listen(PORT, () => {
  console.log("後端啟動：http://localhost:3000")
})
