require("dotenv").config();

const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function main() {
  try {
    const result = await pool.query(`
      SELECT id, restaurant_id, photo_reference
      FROM restaurant_photos
      WHERE photo_reference IS NOT NULL
        AND image_url IS NULL
      ORDER BY id
    `);

    console.log(`找到 ${result.rows.length} 張尚未上傳的圖片`);

    for (const photo of result.rows) {
      try {
        console.log(`開始處理 photo id: ${photo.id}`);

        const response = await axios.get(
  "https://maps.googleapis.com/maps/api/place/photo",
  {
    params: {
      maxwidth: 800,
      photo_reference: photo.photo_reference,
      key: process.env.GOOGLE_MAPS_API_KEY
    },
    responseType: "arraybuffer",
    maxRedirects: 5
  }
);

        const contentType = response.headers["content-type"] || "image/jpeg";

        if (!contentType.startsWith("image/")) {
          console.log(`❌ 不是圖片，content-type: ${contentType}`);
          continue;
        }

        const base64 = Buffer.from(response.data).toString("base64");

        const uploadResult = await cloudinary.uploader.upload(
          `data:${contentType};base64,${base64}`,
          {
            folder: "restaurants",
            public_id: `restaurant_${photo.restaurant_id}_photo_${photo.id}`,
            overwrite: true
          }
        );

        await pool.query(
          `
          UPDATE restaurant_photos
          SET image_url = $1
          WHERE id = $2
          `,
          [uploadResult.secure_url, photo.id]
        );

        console.log(`✅ 完成 photo id: ${photo.id}`);
        console.log(uploadResult.secure_url);
      } catch (err) {
  console.log(`❌ 失敗 photo id: ${photo.id}`);

  if (err.response) {
    console.log("status:", err.response.status);
    console.log("content-type:", err.response.headers["content-type"]);

    const data = err.response.data;

    if (Buffer.isBuffer(data)) {
      console.log(data.toString("utf8").slice(0, 1000));
    } else {
      console.log(data);
    }
  } else {
    console.log("message:", err.message);
  }

  break; // 先停在第一個錯誤，不要一直跑
}
    }

    console.log("全部完成");
  } catch (err) {
    console.log("程式執行失敗");
    console.log(err.message);
  } finally {
    await pool.end();
  }
}

main();