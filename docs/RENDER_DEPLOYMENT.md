# Deploying VERITRACE on Render

This guide walks you through deploying the complete **VERITRACE Deepfake Detection System** on [Render](https://render.com).

---

## ⚡ Option 1: 1-Click Blueprint Deployment (Recommended)

Render provides Infrastructure-as-Code via the included [`render.yaml`](../render.yaml).

### Steps:
1. **Push your code to GitHub**:
   Ensure all changes are pushed to your repo: `https://github.com/sankalpgaonkar/RealTime_DeepFake`.
2. **Log in to Render**:
   Go to [dashboard.render.com](https://dashboard.render.com/) and sign in with GitHub.
3. **Create New Blueprint Instance**:
   - In the top-right corner, click **New +** and select **Blueprint**.
   - Select your GitHub repository: `RealTime_DeepFake`.
   - Render will parse `render.yaml` and show 4 items to be created:
     1. `veritrace-frontend` (Next.js Web Service)
     2. `veritrace-backend` (Node.js API Service)
     3. `veritrace-ml` (PyTorch ML Service)
     4. `veritrace-redis` (Internal Redis)
4. **Enter Environment Variables**:
   - Under `veritrace-backend`, paste your **MongoDB Atlas Connection URI**:
     ```text
     mongodb+srv://<username>:<password>@<cluster-host>/deepfake-detection?retryWrites=true&w=majority
     ```
   - All other secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `ENCRYPTION_IV`) are generated automatically by Render.
5. **Click "Apply"**:
   Render will build and deploy all 4 services together. Once finished, open your `veritrace-frontend` URL (e.g., `https://veritrace-frontend.onrender.com`).

---

## 🛠️ Option 2: Manual Dashboard Setup (Free-Tier Friendly)

If you prefer deploying services one-by-one via the Render dashboard:

### Service 1: Backend API
1. Click **New +** $\rightarrow$ **Web Service**.
2. Connect `https://github.com/sankalpgaonkar/RealTime_DeepFake`.
3. Fill in:
   - **Name:** `veritrace-backend`
   - **Root Directory:** `backend`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add **Environment Variables**:
   - `NODE_ENV`: `production`
   - `PORT`: `10000`
   - `MONGODB_URI`: *Your MongoDB connection string*
   - `DB_NAME`: `deepfake-detection`
   - `JWT_SECRET`: *Any 32-character random string*
   - `ENCRYPTION_KEY`: *Any 32-character string*
   - `ENCRYPTION_IV`: *Any 16-character string*
   - `ML_SERVICE_URL`: `https://veritrace-ml.onrender.com` *(updated after Service 2 is created)*
   - `FRONTEND_URL`: `https://veritrace-frontend.onrender.com` *(updated after Service 3 is created)*

---

### Service 2: ML Inference Service
1. Click **New +** $\rightarrow$ **Web Service**.
2. Connect `https://github.com/sankalpgaonkar/RealTime_DeepFake`.
3. Fill in:
   - **Name:** `veritrace-ml`
   - **Root Directory:** `ml-service`
   - **Environment:** `Python`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 180 app:app`
   - **Plan:** *Starter ($7/mo with 1GB+ RAM is recommended for Vision Transformers, or Free)*
4. Add **Environment Variables**:
   - `PYTHON_VERSION`: `3.11.9`
   - `ML_ENV`: `production`

---

### Service 3: Frontend Web Service
1. Click **New +** $\rightarrow$ **Web Service**.
2. Connect `https://github.com/sankalpgaonkar/RealTime_DeepFake`.
3. Fill in:
   - **Name:** `veritrace-frontend`
   - **Root Directory:** *(leave blank — repository root)*
   - **Environment:** `Node`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start`
4. Add **Environment Variables**:
   - `NODE_ENV`: `production`
   - `NEXT_PUBLIC_API_URL`: `https://veritrace-backend.onrender.com/api`
   - `NEXT_PUBLIC_WS_URL`: `https://veritrace-backend.onrender.com`

---

## 🔍 Verification After Deployment

Once deployment completes, check the health endpoints:

```bash
# 1. Backend Health Check
curl https://veritrace-backend.onrender.com/health
# Expected: {"status":"ok","service":"deepfake-detection-backend",...}

# 2. ML Service Health Check
curl https://veritrace-ml.onrender.com/health
# Expected: {"status":"healthy","model":"prithivMLmods/deepfake-detector-model-v1",...}

# 3. Frontend Dashboard
# Open https://veritrace-frontend.onrender.com in your web browser
```
