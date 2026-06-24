const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// SQLite bazaga ulanish
const dbPath = path.resolve(__dirname, 'magazin.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Xatolik:", err.message);
    else console.log("SQLite bazaga muvaffaqiyatli ulandi.");
});

// Jadvallarni yaratish va tekshirish
db.serialize(() => {
    // Tovar jadvali (Shtrix-kod bilan)
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            barcode TEXT UNIQUE,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'Boshqa',
            stock INTEGER DEFAULT 0,
            cost_price REAL DEFAULT 0,
            price REAL DEFAULT 0
        )
    `);

    // Mijozlar jadvali
    db.run(`
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT DEFAULT 'Kiritilmagan',
            debt REAL DEFAULT 0
        )
    `);

    // Savdo tarixi jadvali (Karta, Naqd va Nasiya hisoboti uchun)
    db.run(`
        CREATE TABLE IF NOT EXISTS sales_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            total_sum REAL,
            payment_method TEXT, -- 'naqd', 'karta' yoki 'nasiya'
            customer_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

/* ==========================================================================
   🔍 1. SHTRIX-KOD (BARCODE) FUNKSIYALARI
   ========================================================================== */

// Shtrix-kod skanerlanganda tovarni bazadan qidirib topish API
app.get('/api/products/barcode/:code', (req, res) => {
    const { code } = req.params;
    db.get("SELECT * FROM products WHERE barcode = ?", [code], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ message: "Bu shtrix-kodga mos mahsulot topilmadi!" });
        res.json(row);
    });
});

// Ombordagi barcha tovarlarni olish
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Yangi tovar qo'shish (Shtrix-kod bilan)
app.post('/api/products', (req, res) => {
    const { barcode, name, category, stock, cost_price, price } = req.body;
    const query = `INSERT INTO products (barcode, name, category, stock, cost_price, price) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [barcode, name, category, Number(stock), Number(cost_price), Number(price)], function(err) {
        if (err) return res.status(500).json({ error: "Shtrix-kod takrorlanmas bo'lishi kerak yoki xatolik yuz berdi!" });
        res.json({ id: this.lastID, barcode, name, category, stock, cost_price, price });
    });
});


/* ==========================================================================
   💳 2. KASSA SAVDOSI (KARTA, NAQD VA NASIYA INTEGRATSIYASI)
   ========================================================================== */

app.post('/api/sales', (req, res) => {
    const { cartItems, paymentMethod, customerId, totalSum } = req.body; 
    // paymentMethod frontenddan: 'naqd', 'karta' yoki 'nasiya' bo'lib keladi

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: "Savat bo'sh!" });
    }

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        let hasError = false;
        let errorMessage = "";

        // A. Ombordan mahsulot qoldig'ini ayirish
        cartItems.forEach(item => {
            db.run(
                `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`,
                [item.quantity, item.id, item.quantity],
                function(err) {
                    if (err) { hasError = true; errorMessage = err.message; }
                    else if (this.changes === 0) { hasError = true; errorMessage = `Omborda ${item.name} yetarli emas!`; }
                }
            );
        });

        // B. Agar to'lov turi NASIYA bo'lsa, mijoz balansiga qarz yozish
        if (paymentMethod === 'nasiya' && customerId) {
            db.run(
                `UPDATE customers SET debt = debt + ? WHERE id = ?`,
                [totalSum, customerId],
                function(err) { if (err) { hasError = true; errorMessage = "Mijoz qarzini yangilashda xatolik!"; } }
            );
        }

        // D. Savdo tarixiga kiritish (Karta yoki Naqd pul ekanligini ajratish uchun)
        db.run(
            `INSERT INTO sales_history (total_sum, payment_method, customer_id) VALUES (?, ?, ?)`,
            [totalSum, paymentMethod, customerId || null],
            function(err) { if (err) { hasError = true; errorMessage = "Tarixga yozishda xatolik!"; } }
        );

        // Yakuniy tekshiruv (Tranzaksiyani yopish)
        setTimeout(() => {
            if (hasError) {
                db.run("ROLLBACK");
                return res.status(400).json({ error: errorMessage });
            } else {
                db.run("COMMIT");
                return res.json({ success: true, message: `To'lov ${paymentMethod} orqali muvaffaqiyatli qabul qilindi!` });
            }
        }, 40);
    });
});


/* ==========================================================================
   👥 3. MIJOZLAR REYESTRI API
   ========================================================================== */

app.get('/api/customers', (req, res) => {
    db.all("SELECT * FROM customers ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/customers', (req, res) => {
    const { name, phone } = req.body;
    db.run(`INSERT INTO customers (name, phone, debt) VALUES (?, ?, 0)`, [name, phone], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, phone, debt: 0 });
    });
});

app.delete('/api/customers/:id', (req, res) => {
    db.run(`DELETE FROM customers WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});


/* ==========================================================================
   📊 4. ANALITIKA (KARTA / NAQD DIAGRAMMASI UCHUN)
   ========================================================================== */
app.get('/api/analytics', (req, res) => {
    const query = `
        SELECT 
            SUM(CASE WHEN payment_method = 'naqd' THEN total_sum ELSE 0 END) as naqd_tushum,
            SUM(CASE WHEN payment_method = 'karta' THEN total_sum ELSE 0 END) as karta_tushum,
            SUM(CASE WHEN payment_method = 'nasiya' THEN total_sum ELSE 0 END) as nasiya_savdo,
            COUNT(*) as jami_savdolar
        FROM sales_history
    `;
    db.get(query, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { naqd_tushum: 0, karta_tushum: 0, nasiya_savdo: 0, jami_savdolar: 0 });
    });
});


// React tayyor build fayllarini (dist papkasini) ko'rsatish
app.use(express.static(path.join(__dirname, '../dist')));

// Har qanday boshqa so'rovlar kelganda oddiy xabar qaytarish
app.use((req, res) => {
  res.status(404).send('Backend Server is Running successfully!');
});

app.listen(PORT, () => {
    console.log(`Premium Backend server http://localhost:${PORT} portida ishlamoqda...`);
});