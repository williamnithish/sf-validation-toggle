# Salesforce Validation Rule Switch

A small full-stack app that:
1. Logs in to a Salesforce org via OAuth 2.0 (Connected App / External Client App, with PKCE support)
2. Pulls all **Validation Rules** on the **Account** object (Tooling API)
3. Shows them with their Active/Inactive state
4. Lets you **create new validation rules directly from the web app** (no need to go into Salesforce Setup)
5. Lets you **delete** a rule
6. Lets you toggle a single rule, or Enable All / Disable All, with a **Rollback to Original** button to discard unsaved changes
7. **Deploys** the active/inactive changes back into the org (Metadata API)

Stack: Node.js + Express backend, plain HTML/CSS/JS frontend (no build step), [jsforce](https://jsforce.github.io/) for all Salesforce API calls.

---

## 1. Create a Salesforce Developer Org

If you don't already have one: go to https://developer.salesforce.com/signup and sign up for a free Developer Edition org.

## 2. Create 4–5 Validation Rules on Account

In your org: **Setup → Object Manager → Account → Validation Rules → New**.
Quick example rule:
- Rule Name: `Account_Name_Required`
- Error Condition Formula: `ISBLANK(Name)`
- Error Message: `Account Name cannot be blank`

Repeat with 4–5 different rules/fields (Phone, Industry, Website, BillingCountry, etc.) so the dashboard has something interesting to show.

## 3. Create a Connected App (this is the "bridge" to the web app)

**Setup → App Manager → New Connected App**

- Connected App Name: `Validation Rule Switch`
- API Name: auto-fills
- Contact Email: your email
- Enable OAuth Settings: ✅
- Callback URL: `http://localhost:3000/auth/callback`
  (Use your deployed URL + `/auth/callback` once you deploy online, e.g. `https://your-app.onrender.com/auth/callback`)
- Selected OAuth Scopes — add:
  - `Manage user data via APIs (api)`
  - `Perform requests at any time (refresh_token, offline_access)`
- Require Secret for Web Server Flow: ✅
- Save, then wait ~5–10 minutes for the Connected App to fully activate.
- On the Connected App detail page click **Manage Consumer Details** to get your:
  - **Consumer Key** → `SF_CLIENT_ID`
  - **Consumer Secret** → `SF_CLIENT_SECRET`

## 4. Configure the app

```bash
cd sf-validation-toggle
cp .env.example .env
```

Edit `.env`:

```
SF_CLIENT_ID=<Consumer Key from step 3>
SF_CLIENT_SECRET=<Consumer Secret from step 3>
SF_CALLBACK_URL=http://localhost:3000/auth/callback
SF_LOGIN_URL=https://login.salesforce.com
SESSION_SECRET=<any random long string>
PORT=3000
```

> If you're using a Sandbox org instead of a Dev org, set `SF_LOGIN_URL=https://test.salesforce.com`.

## 5. Run it

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser.

1. Click **Log in with Salesforce** → log in / allow access on the Salesforce screen → you're redirected to the dashboard.
2. Click **Get Validation Rules** → lists every validation rule on Account with its current Active/Inactive state.
3. Click **+ New Validation Rule** to create one straight from the web app: enter a Rule Name, an Error Condition Formula (same formula syntax as Salesforce Setup, e.g. `ISBLANK(Phone)`), and an Error Message, then **Create Rule**. It's written to Salesforce immediately via the Metadata API and the list refreshes.
4. Flip individual ON/OFF toggles, or use **Enable All** / **Disable All**. Changed-but-not-yet-saved rows show an **UNSAVED** badge. Click **Rollback to Original** to discard those unsaved toggle changes.
5. Click **Deploy Changes** → pushes the new active/inactive states back into Salesforce via the Metadata API and refreshes the list to confirm.
6. Click **Delete** on a row to permanently remove that validation rule from the org (with a confirmation prompt).

## How it works (architecture)

```
Browser  ── /auth/login ──────────────▶  Express server ──▶ Salesforce OAuth Authorize page
Browser  ◀── redirect w/ code ─── Salesforce
Browser  ── /auth/callback?code= ─────▶ Express server ──▶ exchanges code for access/refresh token (jsforce)
                                          stores token in server-side session (cookie = session id only)
Browser  ── GET /api/rules ───────────▶ Express server ──▶ Tooling API SOQL: SELECT ... FROM ValidationRule
Browser  ── POST /api/rules/deploy ───▶ Express server ──▶ Metadata API read() + update() on ValidationRule
```

- **Tooling API** (`conn.tooling.query`) is used to *list* rules — it can query the `ValidationRule` sObject directly with a simple SOQL `WHERE EntityDefinition.DeveloperName = 'Account'`.
- **Metadata API** (`conn.metadata.read` / `conn.metadata.update`) is used to *change* a rule's `active` flag. The Metadata API requires the full rule definition for an update, so the server reads the existing rule(s), flips `active`, and writes them back in one batch call — this is the actual "deploy".
- No Salesforce data or credentials are stored anywhere except the in-memory server session for your current browser session (cleared on logout / server restart).

## Deploying online

Any Node host works (Render, Railway, Heroku, Fly.io, etc.):
1. Push this repo to GitHub.
2. Create a new web service pointing at it, with `npm start` as the start command.
3. Set the same environment variables from `.env` in the host's dashboard.
4. **Important**: update the Connected App's Callback URL in Salesforce to your live URL (e.g. `https://your-app.onrender.com/auth/callback`) and update `SF_CALLBACK_URL` to match exactly.

## File structure

```
sf-validation-toggle/
├── index.js              # Express server: OAuth + Tooling/Metadata API routes
├── package.json
├── .env.example
└── public/
    ├── index.html         # Login page
    ├── dashboard.html     # Validation rules dashboard
    ├── app.js             # Dashboard client logic (fetch rules, toggle, deploy)
    └── style.css
```
