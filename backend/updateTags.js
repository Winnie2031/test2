require("dotenv").config();
const { Pool } = require("pg");
const generateTags = require("./generateTags");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function updateTags() {
  try {
    const result = await pool.query("SELECT id, name FROM restaurants");

    for (const r of result.rows) {
      const tags = generateTags(r.name, r.types || []);

      await pool.query(
        "UPDATE restaurants SET tags = $1 WHERE id = $2",
        [tags, r.id]
      );

      console.log(`${r.name} → ${tags.join(", ")}`);
    }

    console.log("標籤更新完成");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

updateTags();