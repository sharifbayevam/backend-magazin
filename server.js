const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("⚡ Supabase PostgreSQL onlayn bazasiga muvaffaqiyatli ulandi.");

// 1. Ombordagi barcha tovarlarni olish
app.get('/api/products', async (req, res) => {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// 2. Yangi tovar qo'shish (Xatolik kelib chiqmasligi uchun optimallashtirildi)
app.post('/api/products', async (req, res) => {
    const { barcode, name, category, stock, cost_price, price } = req.body;
    
    const { data, error } = await supabase
        .from('products')
        .insert([
            { 
                barcode: barcode ? String(barcode).trim() : null, 
                name: name, 
                category: category || 'Boshqa', 
                stock: Number(stock) || 0, 
                cost_price: Number(cost_price) || 0, 
                price: Number(price) || 0 
            }
        ])
        .select();

    if (error) {
        console.error("Supabase Error:", error);
        return res.status(500).json({ error: "Shtrix-kod takrorlanmas bo'lishi kerak yoki bazada xatolik yuz berdi!" });
    }
    
    res.json(data[0]);
});

// 3. Kassa savdosi API
app.post('/api/sales', async (req, res) => {
    const { cartItems, paymentMethod, customerId, totalSum, cardNumber } = req.body; 

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: "Savat bo'sh!" });
    }

    try {
        for (const item of cartItems) {
            const { data: prod, error: fetchErr } = await supabase
                .from('products')
                .select('stock')
                .eq('id', item.id)
                .single();

            if (fetchErr || !prod) throw new Error(`Mahsulot topilmadi.`);
            if (prod.stock < item.quantity) throw new Error(`Omborda mahsulot yetarli emas!`);

            await supabase
                .from('products')
                .update({ stock: prod.stock - item.quantity })
                .eq('id', item.id);
        }

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

        await supabase
            .from('sales_history')
            .insert([{
                total_sum: Number(totalSum),
                payment_method: paymentMethod,
                customer_id: customerId ? Number(customerId) : null,
                card_number: cardNumber || null
            }]);

        return res.json({ success: true, message: "Savdo muvaffaqiyatli yakunlandi!" });

    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

app.get('/api/customers', async (req, res) => {
    const { data, error } = await supabase.from('customers').select('*').order('id', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

app.post('/api/customers', async (req, res) => {
    const { name, phone } = req.body;
    const { data, error } = await supabase.from('customers').insert([{ name, phone, debt: 0 }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

app.get('/api/analytics', async (req, res) => {
    const { data, error } = await supabase.from('sales_history').select('total_sum, payment_method');
    if (error) return res.status(500).json({ error: error.message });
    let naqd_tushum = 0, karta_tushum = 0, nasiya_savdo = 0;
    if (data) {
        data.forEach(sale => {
            if (sale.payment_method === 'naqd') naqd_tushum += sale.total_sum;
            else if (sale.payment_method === 'karta') karta_tushum += sale.total_sum;
            else if (sale.payment_method === 'nasiya') nasiya_savdo += sale.total_sum;
        });
    }
    res.json({ naqd_tushum, karta_tushum, nasiya_savdo, jami_savdolar: data ? data.length : 0 });
});

app.get('/', (req, res) => res.send('Backend Server is Running!'));

app.listen(PORT, () => console.log(`Server port:${PORT} da ishlamoqda...`));