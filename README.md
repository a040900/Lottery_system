# 🎟️ 住宿券抽獎系統

純靜態網頁(部署在 GitHub Pages)+ Supabase(資料庫與登入)。

- 匯入**獎項**與**抽獎名單**(貼上文字或上傳 CSV/TXT)
- 獎項可以多於人數:**每人最多可得 N 個獎**(預設 2),可由 admin 調整
- **獎項也隨機**(預設開):按「開始抽獎」時獎項牌牆先隨機掃描、停在被抽到的獎,再抽得獎人;可在「管理 → 抽獎設定」關閉,改回由操作員點牌選獎。
- **抽獎模式**(管理 → 抽獎設定):「一人一獎」每人只抽一次,人數抽完抽獎就結束;「先每人一個,再抽第二個」;「完全隨機」。
- 預設先讓每個人都中一個,再抽第二個(可關閉)
- 抽獎由**資料庫伺服器亂數**決定,瀏覽器無法作弊
- 結果抽出即**鎖定**:一般操作員無法修改;只有 **admin** 能「更正得獎人」或「作廢重抽」,必須填原因並留下公開的更正紀錄
- 觀眾不用登入,開網址即可即時看到結果;結果可匯出 CSV

## 角色

| 角色 | 登入 | 能做什麼 |
|---|---|---|
| 觀眾 | 不需要 | 看抽獎與結果(即時更新) |
| operator | 需要 | 執行抽獎 |
| admin | 需要 | 以上全部 + 匯入/刪除資料、改設定、更正/作廢結果 |

## 部署步驟

### 1. 建立 Supabase 專案
到 [supabase.com](https://supabase.com) 建一個免費專案。

### 2. 建立資料表與規則
Dashboard → **SQL Editor** → 貼上 [`supabase/schema.sql`](supabase/schema.sql) 整份 → Run。(可重複執行)

### 3. 建立工作人員帳號
- Dashboard → **Authentication → Providers → Email**:關閉 **Allow new users to sign up**(避免陌生人自己註冊)。
- **Authentication → Users → Add user**:建立 admin(與 operator)的 Email 與密碼,勾選 Auto Confirm。
- 回 SQL Editor 指定角色:

```sql
insert into public.staff (user_id, role)
select id, 'admin' from auth.users where email = 'you@example.com';

insert into public.staff (user_id, role)
select id, 'operator' from auth.users where email = 'helper@example.com';
```

### 4. 填入連線資訊
Project Settings → **API**,把 **Project URL** 與 **anon public key** 填進 [`config.js`](config.js)。
anon key 本來就是公開的,安全性由資料庫規則(RLS)保護,可以放心提交。**不要放 service_role key。**

### 5. 開啟 GitHub Pages
推送到 `main` 後:repo → **Settings → Pages → Source 選 "GitHub Actions"**。
網址會是 `https://<帳號>.github.io/<repo 名稱>/`。

> 私有 repo 要用 GitHub Pages 需要付費方案(Pro/Team)。免費帳號請把 repo 設為 public——
> repo 裡沒有任何機密(anon key 是公開的)。

## 使用流程

1. admin 登入 → **管理**:匯入獎項、匯入名單、確認「每人上限」。
2. 正式抽獎前可以先彩排,結束後用「清空全部抽獎結果」重置(會留下紀錄)。
3. **抽獎**分頁有三個區塊:上方票券舞台(名字滾輪)、中間**獎項卡牌牆**(點一張牌選擇要抽的獎,抽出後該牌翻面顯示得獎人)、下方**名牌牆**(轉動時名牌依序亮起,每人顯示已得 ●/○ 個數)。倒數 3-2-1 與彩帶由 admin 在「管理 → 抽獎設定」開關(全場適用);音效在抽獎頁勾選(預設關閉,記在這台裝置)。
   操作:選獎項 →「開始抽獎」一次抽一個;或按「▶ 連續自動抽」,從選定的獎項開始依序自動抽完剩下的(每個獎揭曉後停留約 3.5 秒),可隨時按「⏸ 暫停」(目前這個獎抽完後停止)。投影這個畫面給現場看。
4. 抽錯人(例如名單有誤)→ admin 到**結果**分頁按「更正」或「作廢」。

### 匯入格式

獎項(每行一個,可加數量):
```
雙人住宿券,5
四人房住宿券 x2
單人住宿券
```
數量大於 1 會展開成 `雙人住宿券 #1 … #5`。

抽獎名單(每行一人,可加備註;同名請加備註區分):
```
王小明
李小華,行銷部
```


## 抽獎規則

- 每次抽獎在資料庫內以交易完成,同一獎項只會被抽一次。
- 排除已達「每人上限」的人。
- 「先每人一個」開啟時:只從目前得獎數最少的人當中隨機抽。例如 6 個獎、3 個人、上限 2,前 3 個獎一定是 3 個不同的人。

## 開發與測試

```bash
npm install
npm test        # 解析器、資料庫規則(PGlite)、UI 流程(jsdom)
python3 -m http.server   # 本機預覽(需先填好 config.js)
```

資料庫規則測試用 PGlite(WASM 版 Postgres)載入 `schema.sql`,驗證權限、每人上限、並發、更正與稽核。
