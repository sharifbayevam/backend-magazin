const express = require('express');
const cors = require('cors');
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
    console.error("❌ Xatolik: SUPABASE_URL yoki SUPABASE_KEY kiritilmagan!");
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("⚡ Supabase PostgreSQL onlayn bazasiga muvaffaqiyatli ulandi.");

/* ==========================================================================
    📦 1. OMBOR (MAHSULOTLAR) REYESTRI VA SHTRIX-KOD API
   ========================================================================== */

// Ombordagi barcha tovarlarni olish
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('id', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Shtrix-kod orqali tovarni qidirish (Kassa uchun)
app.get('/api/products/barcode/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('barcode', String(code).trim())
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ message: "Bu shtrix-kodga mos mahsulot topilmadi!" });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Omborga yangi tovar qo'shish (Xatoliklardan xavfsiz format)
app.post('/api/products', async (req, res) => {
    try {
        const { barcode, name, category, stock, cost_price, price } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: "Mahsulot nomi kiritilishi shart!" });
        }

        const cleanProduct = { 
            name: String(name).trim(), 
            category: category ? String(category).trim() : 'Boshqa', 
            stock: Number(stock) || 0, 
            cost_price: Number(cost_price) || 0, 
            price: Number(price) || 0 
        };

        if (barcode && String(barcode).trim() !== "") {
            cleanProduct.barcode = String(barcode).trim();
        } else {
            cleanProduct.barcode = null;
        }

        const { data, error } = await supabase
            .from('products')
            .insert([cleanProduct])
            .select();

        if (error) {
            console.error("❌ SUPABASE BAZA XATOLIGI:", error.message);
            return res.status(500).json({ error: error.message });
        }
        
        res.json(data ? data[0] : { success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ombordan mahsulotni o'chirish
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('products').delete().eq('id', id);
        
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, message: "Mahsulot o'chirildi." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* ==========================================================================
    💳 2. KASSA SAVDOSI VA NASIYA (QARZ) TIZIMI API
   ========================================================================== */

// To'lov qilish va savdoni yakunlash
app.post('/api/sales', async (req, res) => {
    const { cartItems, paymentMethod, customerId, totalSum, cardNumber } = req.body; 

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: "Savat bo'sh!" });
    }

    try {
        // 1. Ombordan tovar miqdorini kamaytirish
        for (const item of cartItems) {
            const { data: prod, error: fetchErr } = await supabase
                .from('products')
                .select('stock, name')
                .eq('id', item.id)
                .single();

            if (fetchErr || !prod) {
                return res.status(400).json({ error: `Mahsulot topilmadi: ID ${item.id}` });
            }
            if (prod.stock < Number(item.quantity)) {
                return res.status(400).json({ error: `Omborda ${prod.name} yetarli emas!` });
            }

            await supabase
                .from('products')
                .update({ stock: prod.stock - Number(item.quantity) })
                .eq('id', item.id);
        }

        // 2. Nasiya bo'lsa mijoz qarzini oshirish
        if (paymentMethod === 'nasiya' && customerId) {
            const { data: cust } = await supabase
                .from('customers')
                .select('debt')
                .eq('id', customerId)
                .single();

            await supabase
                .from('customers')
                .update({ debt: (cust?.debt || 0) + Number(totalSum) })
                .eq('id', customerId);
        }

        // 3. Savdo tarixiga yozish
        await supabase.from('sales_history').insert([{
            total_sum: Number(totalSum),
            payment_method: paymentMethod,
            customer_id: customerId ? Number(customerId) : null,
            card_number: paymentMethod === 'karta' ? String(cardNumber) : null
        }]);

        return res.json({ success: true, message: "To'lov muvaffaqiyatli qabul qilindi!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Savdolar tarixini yuklash
app.get('/api/sales', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('sales_history')
            .select('*')
            .order('id', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* ==========================================================================
    👥 3. MIJOZLAR (DOIMIY XARIDORLAR) REYESTRI API
   ========================================================================== */

// Mijozlar ro'yxatini olish
app.get('/api/customers', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customers')
            .select('*')
            .order('id', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Yangi mijoz qo'shish
app.post('/api/customers', async (req, res) => {
    try {
        const { name, phone } = req.body;
        if (!name) return res.status(400).json({ error: "Mijoz ismi shart!" });

        const { data, error } = await supabase
            .from('customers')
            .insert([{ name: String(name).trim(), phone: phone || '', debt: 0 }])
            .select();

        if (error) return res.status(500).json({ error: error.message });
        res.json(data ? data[0] : { success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mijozni o'chirish
app.delete('/api/customers/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('customers').delete().eq('id', req.params.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* ==========================================================================
    📊 4. ANALITIKA API
   ========================================================================== */
app.get('/api/analytics', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sales_history').select('total_sum, payment_method');
        if (error) return res.status(500).json({ error: error.message });

        let naqd_tushum = 0, karta_tushum = 0, nasiya_savdo = 0;
        if (data) {
            data.forEach(sale => {
                const sum = Number(sale.total_sum) || 0;
                if (sale.payment_method === 'naqd') naqd_tushum += sum;
                else if (sale.payment_method === 'karta') karta_tushum += sum;
                else if (sale.payment_method === 'nasiya') nasiya_savdo += sum;
            });
        }
        res.json({ naqd_tushum, karta_tushum, nasiya_savdo, jami_savdolar_soni: data ? data.length : 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => res.send('Server is Online!'));

app.listen(PORT, () => {
    console.log(`🚀 Server port:${PORT} da muvaffaqiyatli ishlamoqda.`);
});