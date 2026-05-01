# itext — Anonymous Real-Time Chat

> No sign-in. No database. Pick a name, pick a room, start chatting.

---

## Project Structure

```
itext/
├── client/          ← Static frontend (HTML + CSS + JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server/
│   └── server.js    ← Node.js WebSocket server
├── firebase.json    ← Firebase Hosting config
├── .firebaserc      ← Firebase project alias (edit this)
├── .gitignore
└── package.json
```

---

## Run Locally

```bash
# Install dependencies
npm install

# Start server (Node 18+)
npm start

# Or with auto-reload during dev
npm run dev
```

Open → http://localhost:3000

---

## Host on Firebase + Connect to GitHub

### STEP 1 — Create a Firebase Project

1. Go to https://console.firebase.google.com
2. Click **Add project** → give it a name (e.g. `itext-chat`)
3. Disable Google Analytics if not needed → **Create project**

---

### STEP 2 — Install Firebase CLI

```bash
npm install -g firebase-tools
```

---

### STEP 3 — Login to Firebase

```bash
firebase login
```

A browser window will open — sign in with your Google account.

---

### STEP 4 — Set Your Project ID

Edit `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID` with your actual project ID:

```json
{
  "projects": {
    "default": "itext-chat"   ← your project ID here
  }
}
```

Your project ID is visible in the Firebase Console URL:
`https://console.firebase.google.com/project/YOUR-ID-HERE/...`

---

### STEP 5 — Deploy Frontend to Firebase Hosting

```bash
firebase deploy --only hosting
```

Your frontend is now live at:
`https://YOUR_PROJECT_ID.web.app`

> **Note:** Firebase Hosting serves static files only (HTML/CSS/JS).
> The WebSocket server (Node.js) needs to be hosted separately — see Step 6.

---

### STEP 6 — Host the WebSocket Server

Firebase Hosting cannot run Node.js servers. Use one of these free/cheap options:

#### Option A — Railway (Recommended, free tier)
1. Go to https://railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your itext repo
4. Railway auto-detects Node.js and runs `npm start`
5. Click **Generate Domain** to get your server URL

#### Option B — Render (Free tier, sleeps after 15 min inactivity)
1. Go to https://render.com → **New Web Service**
2. Connect GitHub repo → set **Build Command:** `npm install`
3. Set **Start Command:** `npm start`
4. Deploy and copy your `.onrender.com` URL

#### Option C — Fly.io (Free tier)
```bash
npm install -g flyctl
flyctl auth login
flyctl launch
flyctl deploy
```

---

### STEP 7 — Update WebSocket URL in Frontend

Once your server is deployed, update `client/app.js` line that builds the WebSocket URL.

Find this in `app.js`:
```js
const ws = new WebSocket(`${proto}://${location.host}`);
```

Change it to point to your server:
```js
const SERVER_URL = "wss://your-server.railway.app"; // ← your server URL
const ws = new WebSocket(SERVER_URL);
```

Then redeploy the frontend:
```bash
firebase deploy --only hosting
```

---

### STEP 8 — Connect GitHub for Auto-Deploy (CI/CD)

#### A. Push your project to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/itext.git
git push -u origin main
```

#### B. Set up GitHub Actions for Firebase

Run:
```bash
firebase init hosting:github
```

This will:
- Ask you to authenticate with GitHub
- Ask for your repo name (e.g. `yourname/itext`)
- Auto-generate `.github/workflows/firebase-hosting-merge.yml`
- Auto-generate `.github/workflows/firebase-hosting-pull-request.yml`

After this, every push to `main` auto-deploys to Firebase Hosting.

#### C. Manual GitHub Actions setup (alternative)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Firebase Hosting

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          channelId: live
          projectId: YOUR_FIREBASE_PROJECT_ID
```

Add your Firebase service account key as a GitHub Secret:
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click **Generate new private key** → download the JSON
3. Go to GitHub repo → Settings → Secrets → **New repository secret**
4. Name: `FIREBASE_SERVICE_ACCOUNT` → paste the JSON content

---

## Environment Variables

For production, you can set the port via environment:

```bash
PORT=8080 npm start
```

On Railway/Render, set `PORT` in the environment variables dashboard.

---

## Commands (in chat)

| Command | Effect |
|---------|--------|
| `/nick <name>` | Change your username |
| `/clear` | Clear local chat history |
| `/help` | Show command list |

---

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS — Apple system font, iMessage-style bubbles
- **Backend:** Node.js + `ws` WebSocket library
- **Hosting:** Firebase Hosting (frontend) + Railway/Render (server)
- **Auth:** None — fully anonymous

---

## License

MIT
