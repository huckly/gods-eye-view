# huckly fork：自架與同步

這個 fork 的分支與客製內容：

| 分支 | 內容 |
|---|---|
| `main` | 上游 `bilawalsidhu/gods-eye-view` + 以下客製（部署用） |
| `upstream-main` | 上游 main 的純鏡像（比對用，由 workflow 維護） |

| 客製 | 檔案 | 碰到的上游檔案 |
|---|---|---|
| 預設視角台北 | `src/huckly/home.js` | `src/main.js`（3 行） |
| 台北城市 / 地標 | — | `src/locations.js`（新增 `taipei` 區塊） |
| 正體中文介面 | `src/huckly/i18n.js`、`src/huckly/zh-tw.dict.js` | `src/main.js`（1 行 import） |
| 台灣 CCTV | `config/cctv_sources.taiwan.json`、`deploy/cctv-snapshot.mjs` | 無 |
| 自架 | `deploy/*` | 無 |
| 上游同步 | `.github/workflows/sync-upstream.yml` | 無 |

原則：客製盡量放新檔案，對上游檔案只留「掛勾」等級的改動，讓每日合併幾乎不會衝突。

---

## 一、上游同步怎麼運作

```
03:17  GitHub Actions  sync-upstream.yml
       fetch upstream/main → merge 進 fork main → npm ci / test / build → push
       （衝突或測試失敗 → 不 push，GitHub 寄失敗通知信）

04:30  主機 systemd timer  deploy/update.sh
       git fetch origin main → 有新 commit 才 ff-only pull → 重建容器 → 等 healthy
```

**手動觸發同步**：Actions 分頁 → Sync upstream → Run workflow，或

```bash
gh workflow run sync-upstream.yml -R huckly/gods-eye-view
```

**合併衝突時**（本機處理）：

```bash
git fetch upstream
git merge upstream/main
npm test
git push origin main
```

**上游改了 `.github/workflows/`**：`GITHUB_TOKEN` 無權推送 workflow 檔案，同步會在 push 失敗。
建立 fine-grained PAT（只授權此 repo：Contents + Workflows 讀寫），自行設為 secret：

```bash
gh secret set SYNC_TOKEN -R huckly/gods-eye-view
```

---

## 二、在 Linux Docker 主機上部署

需求：Docker + Compose v2、git、可連 GitHub / npm / 各資料來源。建議至少 2 GB RAM 給容器。

```bash
sudo mkdir -p /opt/gods-eye-view && sudo chown "$(id -u):$(id -g)" /opt/gods-eye-view
git clone https://github.com/huckly/gods-eye-view.git /opt/gods-eye-view
cd /opt/gods-eye-view
GEV_UID=$(id -u) GEV_GID=$(id -g) docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs -f gev   # 首次會跑 npm ci，約數分鐘
```

> 主機端用 HTTPS 唯讀 clone（公開 repo 不需憑證），主機上不放任何 GitHub 金鑰。

### 連線方式（預設不對外）

容器用 host network 並只綁 `127.0.0.1:4173`，從自己電腦開 SSH tunnel：

```bash
ssh -L 4173:127.0.0.1:4173 <主機>
```

再開 <http://localhost:4173>。

為什麼不綁 `0.0.0.0`：開發伺服器代管你的 API 金鑰，任何連得到的人都能花你的額度；
POWER UP 金鑰面板也只接受 loopback 連線，走 Docker bridge 會被拒絕。

⚠️ 綁 127.0.0.1 只擋網路，**同一台主機上的其他使用者仍可連到**。多人共用的主機請評估。

### 自動更新

```bash
sed -e "s#@USER@#$(id -un)#" -e "s#@REPO_DIR@#/opt/gods-eye-view#" \
  deploy/systemd/gev-update.service | sudo tee /etc/systemd/system/gev-update.service
sudo cp deploy/systemd/gev-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gev-update.timer
systemctl list-timers gev-update.timer
```

執行帳號需能用 docker：在 `docker` 群組，或具備免密碼 sudo —— `update.sh` 會自動偵測並改用 `sudo -n env GEV_UID=… GEV_GID=… docker`。

帳號不在 docker 群組時，手動啟動也要把變數帶進 sudo（`sudo` 會清掉環境變數）：

```bash
sudo -n env GEV_UID=$(id -u) GEV_GID=$(id -g) docker compose -f deploy/compose.yaml up -d
```

### 常用指令

| 目的 | 指令 |
|---|---|
| 立即更新 | `deploy/update.sh` |
| 強制重建 | `deploy/update.sh --force` |
| 看狀態 | `docker compose -f deploy/compose.yaml ps` |
| 看 log | `docker compose -f deploy/compose.yaml logs --tail 100 gev` |
| 停止 | `docker compose -f deploy/compose.yaml down` |

可調環境變數（compose 執行前設定）：`GEV_PORT`、`GEV_MEM_LIMIT`（預設 2g）、`GEV_CPUS`（1.5）、
`CCTV_SOURCES_FILE`、`CCTV_FORCE_AUSTIN`（1＝保留內建全球攝影機）、`SNAP_TTL_MS`（≥ 40000）。

---

## 三、API 金鑰（全部可選，免費方案）

金鑰一律在 app 右下角 **POWER UP** 面板自行貼上，會寫入 repo 根目錄的 `.env`（已 gitignore，權限 600），
容器重建不會遺失。**不要把金鑰寫進任何 commit。**

| 服務 | 解鎖功能 | 申請 | 注意 |
|---|---|---|---|
| Cesium ion | 寫實 3D（Google 3D Tiles via ion）＋地形 | <https://ion.cesium.com/signup> → Access Tokens → 建立 token，權限只勾 `assets:read` | Token 會出現在瀏覽器，建議設 Allowed URLs 為 `http://localhost:4173` |
| AISStream | 即時船舶 | <https://aisstream.io> → 用 GitHub 登入 → API Keys | 伺服器端使用，不進瀏覽器 |
| NASA FIRMS | 全球火點 | <https://firms.modaps.eosdis.nasa.gov/api/map_key/> 填 email 取得 MAP_KEY | 每 10 分鐘 5000 次交易上限 |
| OpenSky | 較高的航空器查詢額度 | <https://opensky-network.org> 註冊 → Account → API Client → 建立 client | 取得 Client ID / Secret 兩個值；未設定時可在 `.env` 設 `OPENSKY_AUTH_MODE=anon` |

---

## 四、台灣 CCTV

- 來源：交通部高速公路局「交通資料庫」CCTV（`tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml`），
  授權：政府資料開放授權條款-第1版，需標示來源。
- 高公局只提供 MJPEG 串流、且要求**請求間隔 ≥ 40 秒**；app 對開啟中的攝影機每 10 秒抓一次畫面，
  所以由 `deploy/cctv-snapshot.mjs`（127.0.0.1:4174）從串流擷取單張 JPEG 並每支快取 60 秒。
- 本機 `npm run dev` 時若要看台灣攝影機，另開一個終端機跑 `node deploy/cctv-snapshot.mjs`，
  並在 `.env` 設 `CCTV_SOURCES_FILE=config/cctv_sources.taiwan.json`、`CCTV_FORCE_AUSTIN=1`。
- 攝影機朝向（heading）只依行車方向 N/S/E/W 粗估，投影貼圖可能偏移。
- 臺北市交通局 CCTV 影像需簽約申請，未納入。

## 五、中文介面

- 預設正體中文；網址加 `?lang=en` 切回英文（會記住），`?lang=zh-TW` 切回中文。
- 找未翻譯字串：網址加 `?i18n-debug=1`，操作一輪後在 DevTools console 輸入 `[...hucklyI18n.missing]`，
  補進 `src/huckly/zh-tw.dict.js`。
- 刻意不翻：程式會比對文字的元素（split-flap 動畫、資料圖層 chip、traffic 進度），翻了會壞功能。
- 地球上的 Cesium 標籤（呼號、地名）不是 DOM，不在翻譯範圍。
