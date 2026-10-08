require("dotenv").config();

const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");
const { Pool } = require("pg");

const requiredVariables = [
  "DATABASE_URL",
  "GOOGLE_MAPS_API_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET"
];

for (const name of requiredVariables) {
  if (!process.env[name]) {
    console.error(`缺少環境變數：${name}`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function main() {
  let successCount = 0;
  let failureCount = 0;
  let totalCount = 0;

  try {
    const result = await pool.query(`
      SELECT id, restaurant_id, photo_reference
      FROM restaurant_photos
      WHERE photo_reference IS NOT NULL
        AND photo_reference <> ''
        AND image_url IS NULL
      ORDER BY id
    `);

    totalCount = result.rows.length;

    console.log(`找到 ${totalCount} 張尚未上傳的圖片`);

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
            maxRedirects: 5,
            timeout: 30000
          }
        );

        const contentType =
          response.headers["content-type"] || "image/jpeg";

        if (!contentType.startsWith("image/")) {
          throw new Error(`回傳內容不是圖片：${contentType}`);
        }

        const base64 = Buffer.from(response.data).toString("base64");

        const uploadResult = await cloudinary.uploader.upload(
          `data:${contentType};base64,${base64}`,
          {
            folder: "restaurants",
            public_id:
              `restaurant_${photo.restaurant_id}_photo_${photo.id}`,
            overwrite: true
          }
        );

        const updated = await pool.query(
          `
            UPDATE restaurant_photos
            SET image_url = $1
            WHERE id = $2
              AND image_url IS NULL
          `,
          [uploadResult.secure_url, photo.id]
        );

        if (updated.rowCount === 0) {
          throw new Error("圖片已上傳，但資料列不存在或已有圖片網址");
        }

        successCount++;

        console.log(`成功 photo id: ${photo.id}`);
        console.log(uploadResult.secure_url);
      } catch (error) {
        failureCount++;
        process.exitCode = 1;

        console.error(`失敗 photo id: ${photo.id}`);

        if (error.response) {
          console.error(`HTTP 狀態：${error.response.status}`);
        } else {
          console.error(`原因：${error.message}`);
        }

        console.log("已停止，尚未處理的照片保留，下次可再執行。");
        break;
      }
    }

    console.log("\n========== 本次結果 ==========");
    console.log(`成功：${successCount} 張`);
    console.log(`失敗：${failureCount} 張`);
    console.log(
      `尚未嘗試：${totalCount - successCount - failureCount} 張`
    );
  } catch (error) {
    process.exitCode = 1;
    console.error(`程式執行失敗：${error.message}`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.exitCode = 1;
  console.error(`程式結束失敗：${error.message}`);
});