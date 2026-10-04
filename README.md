# PropertyConnect.com.ng

**Buy, sell and rent property.**

| Account type | Who they are | They can chat with |
|---|---|---|
| Seller | Owner selling a property | Buyers |
| Buyer | Looking to buy | Sellers |
| Agent | Lists houses/flats to rent | Tenants |
| Tenant | Looking to rent | Agents |

- Everyone can browse free. Sellers and agents upload **photos** of their properties.
- **Chat only unlocks when BOTH people have an active subscription.**
  The server enforces this — hiding a button is not the only protection.
- Prices: sellers/agents ₦5,000/month, buyers/tenants ₦3,000/month (change in `.env`).

You do **not** need to install anything on your computer to put this online.
Render (the host) installs everything itself.

---

## Path A — Put it online (no installing)

### 1. Put the files on GitHub
1. Make a free account at github.com and tap **New repository** → name it `propertyconnect`.
2. Tap **uploading an existing file**, then upload everything inside the
   unzipped `backend` folder (keep the `src` and `public` folders as they are).
3. Tap **Commit changes**.

### 2. Host it on Render
1. Sign up at render.com with your GitHub account.
2. **New → Web Service** → choose `propertyconnect`.
3. Build command: `npm install` — Start command: `npm start`.
4. Under **Environment**, add these:
   - `JWT_SECRET` = any long random text
   - `SITE_URL` = your Render address for now (e.g. `https://propertyconnect.onrender.com`)
   - `PAYMENT_PROVIDER` = `paystack` (or `flutterwave`)
   - `PAYSTACK_SECRET_KEY` = your **test** key from dashboard.paystack.com → Settings → API Keys
   - `LISTER_PRICE_NGN` = `5000`, `SEEKER_PRICE_NGN` = `3000`
5. Deploy. Open the address Render gives you — that is your live site.

### 3. Photos and data must survive restarts (important!)
Render's free plan **erases uploaded photos and the database** whenever it
restarts. That is fine for testing but not for real users. Before launch:
1. Use a paid Render instance and add a **Disk** (mount path `/var/data`).
2. Add environment variables: `UPLOAD_DIR=/var/data/uploads` and `DB_PATH=/var/data/data.sqlite`.

### 4. Connect propertyconnect.com.ng
1. Render → your service → **Settings → Custom Domains** → add `propertyconnect.com.ng`.
2. Render shows DNS records. Add them where you bought the domain (Truehost etc.).
3. When it works, change `SITE_URL` to `https://propertyconnect.com.ng`.

### 5. Turn on payment confirmations (webhook)
- **Paystack**: Settings → API Keys & Webhooks → Webhook URL →
  `https://propertyconnect.com.ng/api/webhooks/paystack`
- **Flutterwave**: Settings → Webhooks → `https://propertyconnect.com.ng/api/webhooks/flutterwave`
  and set the secret hash to match `FLW_WEBHOOK_HASH`.

Test with the provider's **test card**, then confirm "Subscribed" appears.

### 6. Go live
Finish Paystack/Flutterwave business verification (start early — it takes days),
swap the test key for the **live** key in Render, and make one small real
payment yourself first.

---

## Path B — Try it on your own computer first (optional)

Needs [Node.js LTS](https://nodejs.org).
```
npm install
cp .env.example .env      (then set JWT_SECRET inside .env)
npm run dev
```
Open http://localhost:4000

---

## What is where
```
src/server.js      all the rules: signup, listings, photo upload, payments, chat
src/db.js          database tables
src/paystack.js    Paystack calls
src/flutterwave.js Flutterwave calls
src/auth.js        passwords + login
public/index.html  the whole website
```
Later, when you have lots of users, move from SQLite to Postgres (only `src/db.js`
and the queries in `server.js` need changing).
