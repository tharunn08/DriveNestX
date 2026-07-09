// ============================================================
//  DRIVENEST – Complete Backend (Node.js + Express + SQLite)
//  Uses better-sqlite3 — a widely-supported native SQLite binding
//  (works on Render and other PaaS, unlike node:sqlite which some
//  hosted Node runtimes don't yet support).
// ============================================================

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------- ENVIRONMENT --------------------
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_change_me';

// Where the SQLite file lives. IMPORTANT for Render/other PaaS: the default
// filesystem on most hosting platforms is EPHEMERAL — it resets on every
// deploy/restart. To keep your data, attach a persistent disk and set
// DB_PATH to a file inside it (e.g. DB_PATH=/data/drivenest.db on Render).
// Without that, the app still works, but data resets on each redeploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'drivenest.db');
if (!process.env.DB_PATH) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// ============================================================
//  SCHEMA (auto-created on boot — no manual migration step needed)
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    image TEXT,
    vehicle_type TEXT NOT NULL DEFAULT 'bike' CHECK(vehicle_type IN ('bike','car')),
    parent_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    compare_at_price REAL,
    brand TEXT,
    category_id INTEGER NOT NULL,
    images TEXT,
    stock INTEGER NOT NULL DEFAULT 10,
    sku TEXT,
    compatible_models TEXT,
    warranty_months INTEGER,
    product_type TEXT NOT NULL DEFAULT 'part' CHECK(product_type IN ('part','accessory')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    total REAL NOT NULL,
    address_street TEXT NOT NULL,
    address_city TEXT NOT NULL,
    address_state TEXT NOT NULL,
    address_pincode TEXT NOT NULL,
    address_country TEXT NOT NULL DEFAULT 'India',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','shipped','delivered')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
);
`);
console.log(`✅ SQLite database ready at ${DB_PATH}`);

// ============================================================
//  DB HELPERS
// ============================================================
// better-sqlite3 throws on `undefined` params — normalize to null.
function n(v) { return v === undefined ? null : v; }
function run(sql, ...params) { return db.prepare(sql).run(...params.map(n)); }
function get(sql, ...params) { return db.prepare(sql).get(...params.map(n)); }
function all(sql, ...params) { return db.prepare(sql).all(...params.map(n)); }

function withTransaction(fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function parseImages(row) {
    if (row && typeof row.images === 'string') {
        try { row.images = JSON.parse(row.images); } catch { row.images = []; }
    }
    return row;
}
function boolify(row, ...fields) {
    if (!row) return row;
    for (const f of fields) if (f in row) row[f] = !!row[f];
    return row;
}

// ============================================================
//  MIDDLEWARE
// ============================================================
const auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        if (!token) throw new Error('No token');
        const decoded = jwt.verify(token, JWT_SECRET);
        const row = get('SELECT id, name, email, role FROM users WHERE id = ?', decoded.id);
        if (!row) throw new Error('User not found');
        req.user = row;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Please authenticate' });
    }
};

const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'admin') next();
    else res.status(403).json({ message: 'Admin access required' });
};

// ============================================================
//  HELPERS
// ============================================================
function getOrCreateCart(userId) {
    const row = get('SELECT id FROM carts WHERE user_id = ?', userId);
    if (row) return row.id;
    return run('INSERT INTO carts (user_id) VALUES (?)', userId).lastInsertRowid;
}

function getCartWithItems(cartId) {
    const items = all(
        `SELECT ci.id, ci.product_id, ci.quantity,
                p.name, p.price, p.images, p.slug, p.stock
         FROM cart_items ci
         JOIN products p ON ci.product_id = p.id
         WHERE ci.cart_id = ?`,
        cartId
    );
    items.forEach(parseImages);
    const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
    return { cartId, items, total: Number(total.toFixed(2)) };
}

// ============================================================
//  ROUTES
// ============================================================

app.get('/api/health', (req, res) => res.json({ status: 'ok', db: 'sqlite' }));

// ---------- AUTH ----------
app.post('/api/auth/register', [
    body('name').notEmpty().trim(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { name, email, password, phone } = req.body;
        if (get('SELECT id FROM users WHERE email = ?', email)) {
            return res.status(400).json({ message: 'Email already exists' });
        }
        const hashed = await bcrypt.hash(password, 10);
        const userId = run(
            'INSERT INTO users (name, email, password, phone) VALUES (?, ?, ?, ?)',
            name, email, hashed, phone
        ).lastInsertRowid;
        run('INSERT INTO carts (user_id) VALUES (?)', userId);

        const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { id: userId, name, email, role: 'user' } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/auth/login', [
    body('email').isEmail(),
    body('password').notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { email, password } = req.body;
        const user = get('SELECT * FROM users WHERE email = ?', email);
        if (!user) return res.status(401).json({ message: 'Invalid credentials' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- CATEGORIES (Public) ----------
app.get('/api/categories', (req, res) => {
    try {
        const { vehicle_type } = req.query;
        let sql = 'SELECT id, name, slug, description, image, vehicle_type FROM categories WHERE is_active = 1';
        const params = [];
        if (vehicle_type === 'bike' || vehicle_type === 'car') {
            sql += ' AND vehicle_type = ?';
            params.push(vehicle_type);
        }
        sql += ' ORDER BY name';
        res.json(all(sql, ...params));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/categories/:slug', (req, res) => {
    try {
        const row = get(
            'SELECT id, name, slug, description, image, vehicle_type FROM categories WHERE slug = ? AND is_active = 1',
            req.params.slug
        );
        if (!row) return res.status(404).json({ message: 'Category not found' });
        res.json(row);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ---------- PRODUCTS (Public) ----------
app.get('/api/products', (req, res) => {
    try {
        const { category, search, type } = req.query;
        let sql = `SELECT p.*, c.name as category_name, c.slug as category_slug
                   FROM products p JOIN categories c ON p.category_id = c.id
                   WHERE p.is_active = 1`;
        const params = [];
        if (category) { sql += ' AND p.category_id = ?'; params.push(category); }
        if (type === 'part' || type === 'accessory') { sql += ' AND p.product_type = ?'; params.push(type); }
        if (search) {
            sql += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.compatible_models LIKE ?)';
            const like = `%${search}%`;
            params.push(like, like, like);
        }
        sql += ' ORDER BY p.created_at DESC';
        const rows = all(sql, ...params);
        rows.forEach(r => { parseImages(r); boolify(r, 'is_active'); });
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/products/:slug', (req, res) => {
    try {
        const row = get(
            `SELECT p.*, c.name as category_name, c.slug as category_slug
             FROM products p JOIN categories c ON p.category_id = c.id
             WHERE p.slug = ? AND p.is_active = 1`,
            req.params.slug
        );
        if (!row) return res.status(404).json({ message: 'Product not found' });
        parseImages(row); boolify(row, 'is_active');
        res.json(row);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ---------- CART (Protected) ----------
app.get('/api/cart', auth, (req, res) => {
    try {
        const cartId = getOrCreateCart(req.user.id);
        res.json(getCartWithItems(cartId));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/cart/add', auth, [
    body('productId').notEmpty(),
    body('quantity').optional().isInt({ min: 1 })
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { productId } = req.body;
        const quantity = parseInt(req.body.quantity) || 1;
        const prod = get('SELECT id FROM products WHERE id = ? AND is_active = 1', productId);
        if (!prod) return res.status(404).json({ message: 'Product not found' });

        const cartId = getOrCreateCart(req.user.id);
        const existing = get('SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, productId);
        if (existing) {
            run('UPDATE cart_items SET quantity = quantity + ? WHERE id = ?', quantity, existing.id);
        } else {
            run('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)', cartId, productId, quantity);
        }
        res.json(getCartWithItems(cartId));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/cart/update', auth, [
    body('productId').notEmpty(),
    body('quantity').isInt({ min: 1 })
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { productId, quantity } = req.body;
        const cartId = getOrCreateCart(req.user.id);
        const existing = get('SELECT id FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, productId);
        if (!existing) return res.status(404).json({ message: 'Item not in cart' });
        run('UPDATE cart_items SET quantity = ? WHERE id = ?', quantity, existing.id);
        res.json(getCartWithItems(cartId));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/cart/remove/:productId', auth, (req, res) => {
    try {
        const cartId = getOrCreateCart(req.user.id);
        run('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, req.params.productId);
        res.json(getCartWithItems(cartId));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/cart/clear', auth, (req, res) => {
    try {
        const cartId = getOrCreateCart(req.user.id);
        run('DELETE FROM cart_items WHERE cart_id = ?', cartId);
        res.json({ message: 'Cart cleared' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ---------- ORDERS (Protected, No Payment) ----------
app.post('/api/orders/create', auth, [
    body('address.street').notEmpty(),
    body('address.city').notEmpty(),
    body('address.state').notEmpty(),
    body('address.pincode').notEmpty()
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ message: 'Complete address required', errors: errors.array() });
    try {
        const { address } = req.body;
        const cartId = getOrCreateCart(req.user.id);
        const items = all(
            `SELECT ci.product_id, ci.quantity, p.price, p.stock, p.name
             FROM cart_items ci JOIN products p ON ci.product_id = p.id
             WHERE ci.cart_id = ?`,
            cartId
        );
        if (items.length === 0) return res.status(400).json({ message: 'Cart is empty' });

        const outOfStock = items.find(i => i.stock < i.quantity);
        if (outOfStock) return res.status(400).json({ message: `Insufficient stock for ${outOfStock.name}` });

        const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);

        const orderId = withTransaction(() => {
            const oid = run(
                `INSERT INTO orders (user_id, total, address_street, address_city, address_state, address_pincode, address_country)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                req.user.id, total, address.street, address.city, address.state, address.pincode, address.country || 'India'
            ).lastInsertRowid;

            for (const item of items) {
                run('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
                    oid, item.product_id, item.quantity, item.price);
                run('UPDATE products SET stock = stock - ? WHERE id = ?', item.quantity, item.product_id);
            }
            run('DELETE FROM cart_items WHERE cart_id = ?', cartId);
            return oid;
        });

        res.status(201).json({ message: 'Order placed successfully', orderId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/orders/my-orders', auth, (req, res) => {
    try {
        const orders = all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', req.user.id);
        for (const order of orders) {
            order.items = all(
                `SELECT oi.product_id, oi.quantity, oi.price, p.name, p.slug
                 FROM order_items oi JOIN products p ON oi.product_id = p.id
                 WHERE oi.order_id = ?`,
                order.id
            );
        }
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ---------- ADMIN ROUTES (Protected + Admin) ----------
app.post('/api/admin/products', auth, adminOnly, (req, res) => {
    try {
        const { name, slug, description, price, compare_at_price, brand, category_id, images, stock, sku, compatible_models, warranty_months, product_type } = req.body;
        if (!name || !slug || !price || !category_id) {
            return res.status(400).json({ message: 'name, slug, price, and category_id are required' });
        }
        const imgJson = (images && images.length) ? JSON.stringify(images) : null;
        const id = run(
            `INSERT INTO products (name, slug, description, price, compare_at_price, brand, category_id, images, stock, sku, compatible_models, warranty_months, product_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            name, slug, description, price, compare_at_price, brand, category_id, imgJson,
            stock || 10, sku, compatible_models, warranty_months, (product_type === 'accessory' ? 'accessory' : 'part')
        ).lastInsertRowid;
        res.status(201).json({ id, message: 'Product created' });
    } catch (err) {
        console.error(err);
        if (String(err.message).includes('UNIQUE')) return res.status(400).json({ message: 'Slug already exists' });
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/admin/products/:id', auth, adminOnly, (req, res) => {
    try {
        const { name, slug, description, price, compare_at_price, brand, category_id, images, stock, sku, is_active, compatible_models, warranty_months, product_type } = req.body;
        const fields = [];
        const values = [];
        if (name) { fields.push('name = ?'); values.push(name); }
        if (slug) { fields.push('slug = ?'); values.push(slug); }
        if (description !== undefined) { fields.push('description = ?'); values.push(description); }
        if (price !== undefined) { fields.push('price = ?'); values.push(price); }
        if (compare_at_price !== undefined) { fields.push('compare_at_price = ?'); values.push(compare_at_price || null); }
        if (brand !== undefined) { fields.push('brand = ?'); values.push(brand); }
        if (category_id) { fields.push('category_id = ?'); values.push(category_id); }
        if (images !== undefined) { fields.push('images = ?'); values.push(images && images.length ? JSON.stringify(images) : null); }
        if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
        if (sku !== undefined) { fields.push('sku = ?'); values.push(sku); }
        if (compatible_models !== undefined) { fields.push('compatible_models = ?'); values.push(compatible_models); }
        if (warranty_months !== undefined) { fields.push('warranty_months = ?'); values.push(warranty_months || null); }
        if (product_type === 'part' || product_type === 'accessory') { fields.push('product_type = ?'); values.push(product_type); }
        if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (fields.length === 0) return res.status(400).json({ message: 'No fields to update' });

        values.push(req.params.id);
        run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, ...values);
        res.json({ message: 'Product updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/admin/products/:id', auth, adminOnly, (req, res) => {
    try {
        run('DELETE FROM products WHERE id = ?', req.params.id);
        res.json({ message: 'Product deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Categories (Admin)
app.post('/api/admin/categories', auth, adminOnly, (req, res) => {
    try {
        const { name, slug, description, image, parent_id, vehicle_type } = req.body;
        if (!name || !slug) return res.status(400).json({ message: 'name and slug are required' });
        const vt = (vehicle_type === 'car') ? 'car' : 'bike';
        const id = run(
            `INSERT INTO categories (name, slug, description, image, parent_id, vehicle_type) VALUES (?, ?, ?, ?, ?, ?)`,
            name, slug, description, image, parent_id, vt
        ).lastInsertRowid;
        res.status(201).json({ id, message: 'Category created' });
    } catch (err) {
        console.error(err);
        if (String(err.message).includes('UNIQUE')) return res.status(400).json({ message: 'Slug already exists' });
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/admin/categories/:id', auth, adminOnly, (req, res) => {
    try {
        const { name, slug, description, image, is_active, vehicle_type } = req.body;
        const fields = [];
        const values = [];
        if (name) { fields.push('name = ?'); values.push(name); }
        if (slug) { fields.push('slug = ?'); values.push(slug); }
        if (description !== undefined) { fields.push('description = ?'); values.push(description); }
        if (image !== undefined) { fields.push('image = ?'); values.push(image || null); }
        if (vehicle_type === 'bike' || vehicle_type === 'car') { fields.push('vehicle_type = ?'); values.push(vehicle_type); }
        if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (fields.length === 0) return res.status(400).json({ message: 'No fields to update' });

        values.push(req.params.id);
        run(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, ...values);
        res.json({ message: 'Category updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/admin/categories/:id', auth, adminOnly, (req, res) => {
    try {
        run('DELETE FROM categories WHERE id = ?', req.params.id);
        res.json({ message: 'Category deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Orders (Admin)
app.get('/api/admin/orders', auth, adminOnly, (req, res) => {
    try {
        const orders = all(
            `SELECT o.*, u.name as user_name, u.email as user_email
             FROM orders o JOIN users u ON o.user_id = u.id
             ORDER BY o.created_at DESC`
        );
        for (const order of orders) {
            order.items = all(
                `SELECT oi.*, p.name, p.slug FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`,
                order.id
            );
        }
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/admin/orders/:id', auth, adminOnly, (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered'];
        if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid status' });
        run('UPDATE orders SET status = ? WHERE id = ?', status, req.params.id);
        res.json({ message: 'Order status updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ---------- SEED ROUTE (dev / first-boot data) ----------
app.post('/api/seed', async (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
        return res.status(403).json({ message: 'Seeding disabled in production (set ALLOW_SEED=true to allow it once)' });
    }
    try {
        withTransaction(() => {
            run('DELETE FROM order_items');
            run('DELETE FROM orders');
            run('DELETE FROM cart_items');
            run('DELETE FROM carts');
            run('DELETE FROM products');
            run('DELETE FROM categories');

            // name, slug, description, image (null = no photo yet), vehicle_type
            const categories = [
                ['Honda', 'honda', 'Genuine and aftermarket spares for Honda CD 110 Dream, Shine, Activa & Unicorn.', null, 'bike'],
                ['Hero', 'hero', 'Spare parts for Hero Splendor, HF Deluxe, Passion & Glamour.', null, 'bike'],
                ['TVS', 'tvs', 'Parts for TVS Apache, Jupiter, Ntorq & Star City.', null, 'bike'],
                ['Bajaj', 'bajaj', 'Parts for Bajaj Pulsar, Platina, CT100 & Avenger.', null, 'bike'],
                ['Yamaha', 'yamaha', 'Parts for Yamaha FZ, R15, Fascino & MT-15.', null, 'bike'],
                ['Suzuki', 'suzuki', 'Parts for Suzuki Access, Gixxer & Burgman.', null, 'bike'],
                ['Royal Enfield', 'royal-enfield', 'Parts for Royal Enfield Classic 350, Bullet, Meteor & Hunter.', null, 'bike'],
                ['Bike Riding Gear & Accessories', 'bike-accessories', 'Helmets, gloves, riding jackets, phone mounts and more for every rider.', null, 'bike'],
                ['Maruti Suzuki', 'maruti-suzuki', 'Car spares for Maruti Suzuki Swift, Baleno, WagonR & Alto.', null, 'car'],
                ['Hyundai', 'hyundai', 'Car spares for Hyundai i10, i20, Creta & Venue.', null, 'car'],
                ['Tata', 'tata', 'Car spares for Tata Nexon, Punch, Tiago & Altroz.', null, 'car'],
                ['Mahindra', 'mahindra', 'Car spares for Mahindra Scorpio, XUV700 & Bolero.', null, 'car'],
                ['Car Care & Accessories', 'car-accessories', 'Seat covers, floor mats, dash cams, organizers and detailing kits.', null, 'car']
            ];
            for (const c of categories) {
                run('INSERT INTO categories (name, slug, description, image, vehicle_type) VALUES (?, ?, ?, ?, ?)', ...c);
            }
            const catRows = all('SELECT id, slug FROM categories');
            const catMap = {};
            catRows.forEach(c => catMap[c.slug] = c.id);

            // name, slug, description, price, compare_at_price, brand, category_slug, stock, compatible_models, warranty_months, product_type
            const products = [
                ['Brake Shoe Set', 'honda-brake-shoe-set', 'Rear brake shoe set with high-friction lining for consistent stopping power.', 450, 550, 'ROLON', 'honda', 15, 'CD 110 Dream, HET, Livo', 6, 'part'],
                ['Clutch Plate Set', 'honda-clutch-plate-set', 'Complete friction + steel plate kit for smooth gear engagement.', 650, 750, 'MK Auto Clutch Co.', 'honda', 12, 'CD 110 Dream, Shine, Unicorn', 6, 'part'],
                ['Air Filter', 'honda-air-filter', 'OEM-fit paper element air filter, improves mileage and engine life.', 180, 220, 'Purolator', 'honda', 20, 'CD 110 Dream, Shine', 3, 'part'],
                ['Spark Plug', 'honda-spark-plug', 'Iridium-tipped spark plug for stronger spark and easier cold starts.', 120, null, 'NGK', 'honda', 30, 'CD 110 Dream, Shine, Unicorn, Activa', 12, 'part'],
                ['Chain Sprocket Kit', 'honda-chain-sprocket-kit', 'Chain + front/rear sprocket combo, heat-treated for long life.', 850, 950, 'DID', 'honda', 10, 'CD 110 Dream, Shine', 6, 'part'],
                ['Front Disc Brake Caliper', 'honda-disc-caliper', 'Direct-fit caliper assembly for consistent braking feel.', 1350, 1500, 'Honda Genuine', 'honda', 6, 'Unicorn, Shine', 6, 'part'],
                ['Brake Pads (Front Disc)', 'hero-brake-pads', 'Semi-metallic front disc brake pads for consistent braking in all weather.', 350, 400, 'Hero Genuine', 'hero', 20, 'Splendor, HF Deluxe, Glamour', 6, 'part'],
                ['Clutch Cable', 'hero-clutch-cable', 'Corrosion-resistant clutch cable with smooth nylon liner.', 140, null, 'Capri', 'hero', 25, 'Splendor, Passion, HF Deluxe', 3, 'part'],
                ['Headlight Assembly', 'hero-headlight-assembly', 'Direct-fit headlight unit with wiring harness included.', 780, 900, 'Hero Genuine', 'hero', 8, 'Splendor Plus, Passion Pro', 6, 'part'],
                ['Engine Oil 20W40 (1L)', 'hero-engine-oil-20w40', 'Semi-synthetic engine oil for smoother gear shifts and cooler running.', 320, null, 'Hero Genuine', 'hero', 40, 'All Hero 100-125cc models', 0, 'part'],
                ['Chain Kit', 'tvs-chain-kit', 'Heavy-duty chain and sprocket kit built for daily city riding.', 950, 1050, 'TVS Original', 'tvs', 10, 'Apache RTR 160, Apache 180', 6, 'part'],
                ['Front Fork Oil Seal Set', 'tvs-fork-oil-seal', 'Prevents fork oil leakage, restores suspension smoothness.', 260, null, 'TVS Original', 'tvs', 18, 'Apache, Star City, Radeon', 3, 'part'],
                ['Carburetor Repair Kit', 'tvs-carb-repair-kit', 'Gasket, float valve and jets kit to fix idling and starting issues.', 380, 430, 'TVS Original', 'tvs', 14, 'Apache RTR 160', 3, 'part'],
                ['Battery (5Ah)', 'tvs-battery-5ah', 'Maintenance-free sealed battery, ready to install.', 1450, 1600, 'Amaron', 'tvs', 9, 'Jupiter, Ntorq, Apache', 12, 'part'],
                ['Pulsar Silencer (Exhaust)', 'bajaj-pulsar-silencer', 'OEM-spec exhaust silencer, BS6 compliant, direct bolt-on fit.', 2200, 2500, 'Bajaj Genuine', 'bajaj', 6, 'Pulsar 150, Pulsar 220F', 12, 'part'],
                ['Disc Brake Rotor', 'bajaj-disc-brake-rotor', 'Precision-machined front disc rotor for reduced brake judder.', 890, 990, 'Bajaj Genuine', 'bajaj', 11, 'Pulsar 150, Pulsar 180F', 12, 'part'],
                ['Fuel Pump Assembly', 'bajaj-fuel-pump', 'Fuel-injected model fuel pump with pressure regulator.', 1650, null, 'Bajaj Genuine', 'bajaj', 7, 'Pulsar NS200, Pulsar RS200', 6, 'part'],
                ['Handle Grip Set', 'bajaj-handle-grip-set', 'Anti-slip rubber grips for better control in all conditions.', 190, null, 'Bajaj Genuine', 'bajaj', 25, 'Pulsar, Avenger, Platina', 3, 'part'],
                ['R15 Rear Tyre', 'yamaha-r15-rear-tyre', 'Tubeless radial tyre for sharper cornering grip.', 3200, 3600, 'MRF', 'yamaha', 8, 'R15 V3, R15 V4', 12, 'part'],
                ['FZ Clutch Plate Kit', 'yamaha-fz-clutch-kit', 'Wet multi-plate clutch kit for consistent power delivery.', 720, 800, 'Yamaha Genuine', 'yamaha', 10, 'FZ-S, FZ25', 6, 'part'],
                ['Radiator Coolant (1L)', 'yamaha-radiator-coolant', 'Long-life coolant for liquid-cooled engines, prevents overheating.', 260, null, 'Yamaha Genuine', 'yamaha', 22, 'R15, MT-15, FZ25', 0, 'part'],
                ['Access CVT Belt', 'suzuki-access-cvt-belt', 'High-durability CVT drive belt for scooters.', 980, 1100, 'Suzuki Genuine', 'suzuki', 9, 'Access 125', 6, 'part'],
                ['Gixxer Brake Lever Set', 'suzuki-gixxer-brake-lever', 'Front and clutch lever set, folding-tip design to reduce breakage.', 340, null, 'Suzuki Genuine', 'suzuki', 16, 'Gixxer, Gixxer SF', 3, 'part'],
                ['Classic 350 Silencer', 'royal-enfield-classic-350-silencer', 'Signature thump exhaust, BS6 compliant, chrome-finished.', 4200, 4800, 'Royal Enfield Genuine', 'royal-enfield', 5, 'Classic 350 (2021+)', 12, 'part'],
                ['Bullet Primary Chain Case Gasket', 'royal-enfield-bullet-gasket-set', 'Complete gasket set to stop primary chain case oil seepage.', 320, null, 'Royal Enfield Genuine', 'royal-enfield', 14, 'Bullet 350, Classic 350', 6, 'part'],
                ['Meteor 350 Front Brake Pads', 'royal-enfield-meteor-brake-pads', 'High-grip sintered brake pads for confident stopping.', 480, 550, 'Royal Enfield Genuine', 'royal-enfield', 12, 'Meteor 350, Classic 350', 6, 'part'],
                ['Battery 65Ah (12V)', 'royal-enfield-battery-65ah', 'Maintenance-free VRLA battery for reliable kick/self start.', 2600, 2900, 'Exide', 'royal-enfield', 6, 'Classic 350, Meteor 350, Hunter 350', 18, 'part'],
                ['ISI-Marked Full Face Helmet', 'bike-full-face-helmet', 'DOT/ISI certified full-face helmet with anti-fog visor and quick-release strap.', 1899, 2299, 'Steelbird', 'bike-accessories', 25, 'Universal (58-60cm)', 12, 'accessory'],
                ['Riding Gloves (All-Weather)', 'bike-riding-gloves', 'Touchscreen-compatible riding gloves with knuckle protection.', 699, 899, 'Royal Enfield Gear', 'bike-accessories', 30, 'Universal M/L/XL', 6, 'accessory'],
                ['Mobile Phone Mount', 'bike-phone-mount', 'Vibration-dampening handlebar mount, fits most phone sizes.', 449, 599, 'Generic', 'bike-accessories', 40, 'Universal handlebar 22-28mm', 6, 'accessory'],
                ['Saddle Bag (Pair)', 'bike-saddle-bag', 'Water-resistant saddle bags with reflective strips, 20L combined capacity.', 1299, 1599, 'Viaterra', 'bike-accessories', 15, 'Universal, strap-mount', 12, 'accessory'],
                ['Bike Cover (Water Resistant)', 'bike-cover', 'UV and water-resistant cover to protect paint and chrome finish.', 599, 750, 'Generic', 'bike-accessories', 22, 'Fits most 100-350cc bikes', 6, 'accessory'],
                ['Swift Front Brake Pad Set', 'maruti-swift-brake-pads', 'OE-grade ceramic brake pads for quieter, dust-free braking.', 1450, 1650, 'Bosch', 'maruti-suzuki', 12, 'Swift (2018+), Baleno', 12, 'part'],
                ['WagonR Air Filter', 'maruti-wagonr-air-filter', 'High-flow air filter for better throttle response.', 380, null, 'Maruti Genuine', 'maruti-suzuki', 20, 'WagonR, Alto K10', 6, 'part'],
                ['Cabin AC Filter', 'maruti-cabin-ac-filter', 'Removes dust and pollen for cleaner cabin air.', 320, 380, 'Maruti Genuine', 'maruti-suzuki', 25, 'Swift, Baleno, WagonR, Dzire', 6, 'part'],
                ['i20 Wiper Blade Set', 'hyundai-i20-wiper-set', 'Frameless wiper blades, streak-free performance in monsoon.', 650, 750, 'Bosch', 'hyundai', 18, 'i20, i20 Active', 12, 'part'],
                ['Creta Headlamp Assembly', 'hyundai-creta-headlamp', 'Direct-fit projector headlamp assembly, plug-and-play.', 6200, 6800, 'Hyundai Genuine', 'hyundai', 4, 'Creta (2020+)', 12, 'part'],
                ['Nexon Brake Disc (Front)', 'tata-nexon-brake-disc', 'Vented front brake disc for improved heat dissipation.', 2100, 2400, 'Tata Genuine', 'tata', 7, 'Nexon (2017+)', 12, 'part'],
                ['Tiago Battery (35Ah)', 'tata-tiago-battery', 'Zero-maintenance battery with 3-year warranty.', 4200, 4600, 'Amaron', 'tata', 6, 'Tiago, Tigor, Altroz', 36, 'part'],
                ['Scorpio Shock Absorber (Rear)', 'mahindra-scorpio-shock-absorber', 'Gas-charged rear shock absorber for a firmer, controlled ride.', 3400, 3800, 'Gabriel', 'mahindra', 5, 'Scorpio (2014+), Bolero', 24, 'part'],
                ['XUV700 Cabin Air Filter', 'mahindra-xuv700-cabin-filter', 'Activated-carbon cabin filter for better air quality inside.', 420, null, 'Mahindra Genuine', 'mahindra', 16, 'XUV700', 6, 'part'],
                ['5-Seater Car Seat Cover Set', 'car-seat-cover-set', 'Waterproof leatherette seat covers, custom-fit for sedans and hatchbacks.', 3499, 4200, 'Autofurnish', 'car-accessories', 10, 'Universal 5-seater sedan/hatchback', 6, 'accessory'],
                ['All-Weather Floor Mats (Set of 4)', 'car-floor-mats', 'Odorless rubber floor mats, easy to clean, anti-skid backing.', 1299, 1599, 'Elegant', 'car-accessories', 20, 'Universal, trim-to-fit', 12, 'accessory'],
                ['Dash Cam (Full HD)', 'car-dash-cam', '1080p front dash camera with loop recording and night vision.', 2799, 3299, 'Generic', 'car-accessories', 12, 'Universal 12V', 12, 'accessory'],
                ['Car Vacuum Cleaner (Portable)', 'car-vacuum-cleaner', 'Compact 12V vacuum for quick interior cleanups on the go.', 1099, 1399, 'Generic', 'car-accessories', 18, 'Universal 12V socket', 6, 'accessory'],
                ['Car Perfume & Organizer Combo', 'car-perfume-organizer', 'Backseat organizer with built-in air freshener holder.', 599, 749, 'Generic', 'car-accessories', 25, 'Universal', 0, 'accessory']
            ];
            for (const p of products) {
                const [name, slug, description, price, compare_at_price, brand, catSlug, stock, compatible_models, warranty_months, product_type] = p;
                run(
                    `INSERT INTO products (name, slug, description, price, compare_at_price, brand, category_id, images, stock, compatible_models, warranty_months, product_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                    name, slug, description, price, compare_at_price, brand, catMap[catSlug], stock, compatible_models, warranty_months, product_type
                );
            }
        });

        if (!get('SELECT id FROM users WHERE email = ?', 'admin@drivenest.com')) {
            const hashed = await bcrypt.hash('admin123', 10);
            run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`, 'Admin', 'admin@drivenest.com', hashed, 'admin');
        }

        res.json({ message: 'Seed completed successfully! Admin login: admin@drivenest.com / admin123' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Seed failed', error: err.message });
    }
});

// ---------- ROOT / SPA FALLBACK ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', (req, res) => {
    res.status(404).json({ message: 'API endpoint not found' });
});

// ---------- START SERVER ----------
app.listen(PORT, () => console.log(`🚀 DriveNest server running on port ${PORT}`));

module.exports = app;
