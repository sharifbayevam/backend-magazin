const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 🌐 SUPABASE ONLAYN BAZASIGA ULANISH
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Xatolik: .env faylida SUPABASE_URL yoki SUPABASE_KEY kiritilmagan!");
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("⚡ Supabase PostgreSQL onlayn bazasiga muvaffaqiyatli ulandi.");

/* ==========================================================================
    🔍 1. SHTRIX-KOD VA MAHSULOTLAR API (SUPABASE)
   ========================================================================== */

// Shtrix-kod orqali tovarni bazadan qidirish
app.get('/api/products/barcode/:code', async (req, res) => {
    const { code } = req.params;
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('barcode', String(code).trim())
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ message: "Bu shtrix-kodga mos mahsulot topilmadi!" });
    res.json(data);
});

// Ombordagi barcha tovarlarni olish
app.get('/api/products', async (req, res) => {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// Yangi tovar qo'shish (MUTLAQ HIMOYA BILAN)
app.post('/api/products', async (req, res) => {
    const { barcode, name, category, stock, cost_price, price } = req.body;
    
    // Ma'lumotlarni PostgreSQL tushunadigan toza turlarga o'giramiz
    const cleanProduct = { 
        barcode: barcode ? String(barcode).trim() : null, 
        name: String(name).trim(), 
        // AGAR jadvalda category ustuni muammo qilayotgan bo'lsa, xatolik bermasligi uchun
        category: category && typeof category === 'string' ? category.trim() : 'Boshqa', 
        stock: parseInt(stock, 10) || 0, 
        cost_price: parseFloat(cost_price) || 0, 
        price: parseFloat(price) || 0 
    };

    const { data, error } = await supabase
        .from('products')
        .insert([cleanProduct])
        .select();

    if (error) {
        console.error("❌ SUPABASE BAZA XATOLIGI:", error.message, error.details, error.hint);
        
        // Front-endda aniq nima xato bo'lganini bilishimiz uchun haqiqiy xatoni qaytaramiz:
        return res.status(500).json({ 
            error: `Baza xatoli: ${error.message}. Tafsilot: ${error.details || 'yoq'}` 
        });
    }
    
    res.json(data ? data[0] : { success: true });
});

// Ombordan mahsulotni o'chirish
app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: "Mahsulot ombordan muvaffaqiyatli o'chirildi." });
});


/* ==========================================================================
    💳 2. KASSA SAVDOSI VA SAVDOLAR TARIXI API
   ========================================================================== */

// Yangi savdo qo'shish (Sotuv jarayoni)
app.post('/api/sales', async (req, res) => {
    const { cartItems, paymentMethod, customerId, totalSum, cardNumber } = req.body; 

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: "Savat bo'sh!" });
    }

    try {
        for (const item of cartItems) {
            const { data: prod, error: fetchErr } = await supabase
                .from('products')
                .select('stock, name')
                .eq('id', item.id)
                .single();

            if (fetchErr || !prod) throw new Error(`Mahsulot topilmadi: ID ${item.id}`);
            if (prod.stock < parseInt(item.quantity, 10)) throw new Error(`Omborda ${prod.name} yetarli emas!`);

            const { error: updErr } = await supabase
                .from('products')
                .update({ stock: prod.stock - parseInt(item.quantity, 10) })
                .eq('id', item.id);

            if (updErr) throw new Error("Ombor qoldig'ini yangilashda xatolik yuz berdi.");
        }

        if (paymentMethod === 'nasiya' && customerId) {
            const { data: cust, error: custFetchErr } = await supabase
                .from('customers')
                .select('debt')
                .eq('id', customerId)
                .single();

            if (custFetchErr) throw new Error("Mijoz ma'lumotlarini yuklashda xatolik.");

            const { error: custUpdErr } = await supabase
                .from('customers')
                .update({ debt: (cust.debt || 0) + parseFloat(totalSum) })
                .eq('id', customerId);

            if (custUpdErr) throw new Error("Mijoz qarzini yangilashda xatolik!");
        }

        const { error: historyErr } = await supabase
            .from('sales_history')
            .insert([{
                total_sum: parseFloat(totalSum),
                payment_method: paymentMethod,
                customer_id: customerId ? Number(customerId) : null,
                card_number: paymentMethod === 'karta' ? cardNumber : null
            }]);

        if (historyErr) throw new Error("Savdo tarixiga yozishda xatolik yuz berdi.");

        return res.json({ success: true, message: `To'lov ${paymentMethod} orqali muvaffaqiyatli qabul qilindi!` });

    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

// Savdolar tarixini front-endga yuklab berish
app.get('/api/sales', async (req, res) => {
    const { data, error } = await supabase
        .from('sales_history')
        .select('*')
        .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});


/* ==========================================================================
    👥 3. MIJOZLAR REYESTRI API
   ========================================================================== */

app.get('/api/customers', async (req, res) => {
    const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

app.post('/api/customers', async (req, res) => {
    const { name, phone } = req.body;
    const { data, error } = await supabase
        .from('customers')
        .insert([{ name: String(name).trim(), phone: phone || 'Kiritilmagan', debt: 0 }])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data ? data[0] : { success: true });
});

app.delete('/api/customers/:id', async (req, res) => {
    const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});


/* ==========================================================================
    📊 4. ANALITIKA API
   ========================================================================== */
app.get('/api/analytics', async (req, res) => {
    const { data, error } = await supabase
        .from('sales_history')
        .select('total_sum, payment_method');

    if (error) return res.status(500).json({ error: error.message });

    let naqd_tushum = 0;
    let karta_tushum = 0;
    let nasiya_savdo = 0;
    let jami_savdolar = data ? data.length : 0;

    if (data) {
        data.forEach(sale => {
            const sum = parseFloat(sale.total_sum) || 0;
            if (sale.payment_method === 'naqd') naqd_tushum += sum;
            else if (sale.payment_method === 'karta') karta_tushum += sum;
            else if (sale.payment_method === 'nasiya') nasiya_savdo += sum;
        });
    }

    res.json({ naqd_tushum, karta_tushum, nasiya_savdo, jami_savdolar });
});

app.get('/', (req, res) => {
    res.send('Backend Server with Supabase is Running Successfully!');
});

app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: "Bunday API manzili mavjud emas!" });
    }
    res.status(200).send('Backend Server is Running Successfully!');
});

app.listen(PORT, () => {
    console.log(`Premium Backend server port:${PORT} da muvaffaqiyatli ishlamoqda...`);
});