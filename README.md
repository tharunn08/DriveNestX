# DriveNest – Bike & Car Spare Parts + Accessories (Node.js + Express + SQLite)

A complete, tested full-stack e-commerce app: brand catalogs, spare parts, accessories, cart, checkout (no payment gateway), order history, and an admin dashboard. Now running on **SQLite** so it deploys cleanly on platforms like Render with zero external database setup.

## Why SQLite (and why the MySQL version failed on Render)

Render doesn't provide a managed MySQL database — only PostgreSQL and Redis. The earlier MySQL version needed a MySQL server reachable at `DB_HOST`, which didn't exist in your Render environment, hence "SQL not connected."

This version uses Node's **built-in `node:sqlite` module** (no `mysql2`, no `better-sqlite3`, no native compilation of any kind). The database is a single file, created automatically the first time the app boots — there's no separate database server to configure, and no `schema.sql` to run by hand.

**The one thing to know:** most hosting platforms, Render included, use an **ephemeral filesystem** by default — files reset on every redeploy or restart. That means your SQLite file will reset too, unless you attach a persistent disk. See the deployment steps below; it's a two-minute setup and after that your data is safe across deploys.

## What's included
```
drivenest/
├── server.js          # Express API + embedded SQLite schema (auto-created on boot)
├── package.json
├── .env.example        # copy to .env locally
├── .node-version        # pins Node 22.12 (node:sqlite needs Node 22.5+)
└── public/
    └── index.html      # the entire frontend (Bootstrap 5 SPA)
```
There's no `schema.sql` anymore — `server.js` creates every table itself on startup with `CREATE TABLE IF NOT EXISTS`, so there's nothing extra to run.

## Run it locally

```bash
npm install
npm start
```
Visit **http://localhost:5000**. A `data/drivenest.db` file is created automatically.

Load demo data (13 brand/category pages, ~45 spare parts and accessories, plus an admin account):
```bash
curl -X POST http://localhost:5000/api/seed
```
Admin login: `admin@drivenest.com` / `admin123`

## Deploying on Render

1. **Push this project to a GitHub repo** (Render deploys from a repo).
2. **New → Web Service** on Render, connect the repo.
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. **Environment variables** (Render dashboard → Environment):
   - `JWT_SECRET` — any long random string
   - `DB_PATH` — `/data/drivenest.db` (see disk step below)
   - `ALLOW_SEED` — `true` (so you can hit `/api/seed` once after your first deploy; you can remove this afterward)
6. **Add a persistent disk** (Render dashboard → Disks → Add Disk):
   - Mount path: `/data`
   - Size: 1 GB is plenty for this app
   - This is the step that makes your data survive redeploys. Without it, every deploy wipes the SQLite file.
7. Deploy. Once it's live, run the seed once:
   ```bash
   curl -X POST https://your-app.onrender.com/api/seed
   ```
8. (Optional but recommended) After seeding, remove the `ALLOW_SEED` env var or set it to `false` so a stray request can't wipe your catalog later — the seed route deletes all products/categories/orders before repopulating.

If you skip the disk step, the app still runs fine — it just starts with an empty (or demo) catalog again after every redeploy, since Render wipes non-disk storage on each deploy.

## What's new since the last version

- **Bike vs Car selector** — homepage tabs (`All / Bikes / Cars`) filtering brands and products by `vehicle_type`.
- **Accessories, not just spare parts** — two new categories, "Bike Riding Gear & Accessories" (helmets, gloves, phone mounts, saddle bags, bike covers) and "Car Care & Accessories" (seat covers, floor mats, dash cams, vacuum cleaners, organizers). Every product has a `product_type` of `part` or `accessory`, shown as a purple "Accessory" badge on its card, and filterable via `GET /api/products?type=accessory`.
- **13 brand/category pages, ~45 products total** — every brand (including the ones that were previously empty — Royal Enfield, Bajaj, Yamaha, Suzuki) now has real listed products.
- **Richer product info** — `compatible_models` (which bike/car models a part fits) and `warranty_months` shown on every card and detail view.
- **Services section, footer, hero banner** — homepage now explains delivery, fitment guidance, warranty, returns and support; footer has contact info and quick links.
- **Clean inline placeholders** — products/categories without a photo show a neutral "Photo coming soon" SVG instead of a broken image or third-party placeholder service.

## Verified working (tested end-to-end against a live instance of this exact SQLite setup)
- ✅ Server boots with zero external dependencies and auto-creates its schema
- ✅ Data survives a full process restart (the persistence you'll rely on with a Render disk)
- ✅ Registration, login, duplicate-email rejection, wrong-password rejection
- ✅ Every brand category (including the ones that used to be empty) returns real products
- ✅ Bike/Car vehicle-type filtering on categories and products
- ✅ Cart add/update/remove/clear, checkout with stock validation inside a transaction, stock correctly decremented after an order
- ✅ Order history for customers and for admins
- ✅ Admin-only routes correctly return 403 for regular users
- ✅ Accessory products (helmets, seat covers, etc.) purchasable through the same cart/checkout flow as spare parts

## Security reminders before going fully live
- Change `JWT_SECRET` to a long random value — don't use the example.
- Put this behind HTTPS (Render does this automatically for you).
- Consider rate-limiting `/api/auth/login` and `/api/auth/register` if this becomes a public-facing store.
- Turn off `ALLOW_SEED` once you're done seeding — the seed route deletes all existing catalog/order data before repopulating.
