# AI開発継続用 技術仕様書
## スケジュール管理 Discord Bot — v4

> **用途**: 次回AIに開発の続きを依頼する際の引き継ぎ資料

---

## 1. プロジェクト概要

Discord サーバー上で Google カレンダーの予定を管理・表示・通知する Bot。  
スラッシュコマンドは使用せず、チャンネルに固定投稿した2つのEmbedとボタンUIで操作する。

**バージョン**: v4  
**最終更新**: 2026-05-16

---

## 2. 技術スタック

| 項目 | 内容 |
|------|------|
| ランタイム | Node.js v18+ |
| Discord | discord.js v14 |
| カレンダー | Google Calendar API v3（googleapis） |
| スケジューラ | node-cron v3 |
| 設定管理 | dotenv |
| 永続化 | JSON ファイル（`data/` ディレクトリ） |

**Discordインテント**: `GatewayIntentBits.Guilds` のみ

---

## 3. ファイル構成と役割

```
src/
├── index.js      ★ メインエントリ。全インタラクションハンドラ、cron管理
├── calendar.js   Google Calendar API ラッパー（CRUD + hashEvents + formatEvent）
├── embed.js      全 EmbedBuilder・ActionRowBuilder のファクトリ
├── modals.js     追加・編集モーダルのファクトリ
├── storage.js    state.json・notices.json の読み書き
└── notifier.js   cron定期呼び出しによる通知チェック・送信

data/
├── state.json    Bot状態（メッセージID、最終ハッシュ等）
└── notices.json  通知設定（eventId → 通知リスト）
```

---

## 4. 環境変数（`.env`）

| 変数名 | 説明 | 省略時 |
|--------|------|--------|
| `DISCORD_TOKEN` | Bot トークン | 必須 |
| `DISCORD_CHANNEL_ID` | カレンダー投稿チャンネルID | 必須 |
| `GOOGLE_CLIENT_EMAIL` | GCPサービスアカウントメール | 必須 |
| `GOOGLE_PRIVATE_KEY` | GCP秘密鍵（`\n` 含む文字列） | 必須 |
| `GOOGLE_CALENDAR_ID` | 対象カレンダーID | 必須 |
| `OPERATOR_ROLE_NAME` | 操作許可ロール名 | `CalendarOperator` |
| `NOTIFY_CHANNEL_ID` | 通知送信先チャンネルID | `DISCORD_CHANNEL_ID` を使用 |
| `LOG_CHANNEL_ID` | 操作ログ送信先チャンネルID | 未設定でログなし |
| `CRON_SCHEDULE` | cron式 | `*/5 * * * *` |

---

## 5. データ構造

### `data/state.json`
```json
{
  "calendarMessageId": "1234567890",
  "statusMessageId":   "0987654321",
  "lastHash":          "a1b2c3d4",
  "updatedAt":         "2026-05-16T10:00:00.000Z"
}
```

### `data/notices.json`
```json
{
  "googleCalEventId": [
    { "roleId": "discordRoleId", "minutesBefore": 60 },
    { "roleId": "discordUserId", "minutesBefore": 30, "targetType": "user" },
    { "roleId": "@everyone",     "minutesBefore": 5 },
    { "roleId": "@here",         "minutesBefore": 10, "firedAt": "2026-05-16T09:00:00.000Z" }
  ]
}
```

`targetType: "user"` がある場合はユーザーメンション。ない場合はロールメンション。  
`firedAt` は通知済みマーク（ISO文字列）。

---

## 6. 権限設計

```js
function hasPermission(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => r.name === OPERATOR_ROLE_NAME);
}
```

**権限チェック不要**: `btn_refresh`, `btn_prev_*`, `btn_next_*`, 通知設定系ボタン全般, 通知削除セレクト  
**権限チェック必要**: `btn_add`, `btn_edit_select`, `btn_delete_select`, 編集・削除系セレクト

---

## 7. カスタムID一覧（ボタン / セレクト / モーダル）

### ボタン
| customId | 権限 | 説明 |
|----------|------|------|
| `btn_refresh` | 不要 | カレンダー強制更新 |
| `btn_prev_{year}_{month}` | 不要 | 先月表示 |
| `btn_next_{year}_{month}` | 不要 | 翌月表示 |
| `btn_add` | 必要 | 追加モーダル表示 |
| `btn_edit_select` | 必要 | 編集予定選択メニュー表示 |
| `btn_delete_select` | 必要 | 削除予定選択メニュー表示 |
| `btn_confirm_delete_{eventId}` | 不要(*) | 削除実行 |
| `btn_cancel_delete` | 不要 | 削除キャンセル |
| `btn_notify_everyone_{eventId}` | 不要 | @everyone通知 |
| `btn_notify_here_{eventId}` | 不要 | @here通知 |
| `btn_notify_t_{eventId}_{roleId}_{minutes}` | 不要 | ロール通知時間確定 |
| `btn_notify_u_{eventId}_{roleId}_{minutes}` | 不要 | ユーザー通知時間確定 |
| `btn_notify_skip_{eventId}` | 不要 | 通知設定スキップ |
| `btn_notify_done_{eventId}` | 不要 | 通知設定完了 |
| `btn_notify_more_{eventId}` | 不要 | 通知追加（管理ビューへ） |
| `btn_nmgr_add_{eventId}` | 不要 | 通知管理：通知追加 |
| `btn_nmgr_del_{eventId}` | 不要 | 通知管理：通知削除メニュー |
| `btn_nmgr_done_{eventId}` | 不要 | 通知管理：完了 |

(*) `btn_confirm_delete_` はephemeralaの中で呼ばれるため権限チェック前に通過

### セレクトメニュー
| customId | 権限 | 説明 |
|----------|------|------|
| `select_edit_event` | 必要 | 編集する予定を選択 |
| `select_delete_event` | 必要 | 削除する予定を選択 |
| `select_notify_role_{eventId}` | 不要 | 通知ロール選択（RoleSelectMenu） |
| `select_notify_user_{eventId}` | 不要 | 通知ユーザー選択（UserSelectMenu） |
| `select_nmgr_del_{eventId}` | 不要 | 通知削除対象選択 |

### モーダル
| customId | 説明 |
|----------|------|
| `modal_add` | 予定追加フォーム |
| `modal_edit_{eventId}` | 予定編集フォーム |

#### モーダルフィールド（追加・編集共通）
| フィールドID | 必須 | 説明 |
|------------|------|------|
| `title` | ✓ | タイトル（最大100文字） |
| `date` | ✓ | 日付 `YYYY-MM-DD` |
| `start_time` | - | 開始時刻（`HHMM` / `HH:MM` / 24時以上も可） |
| `end_time` | - | 終了時刻（同上） |
| `description` | - | 詳細（最大500文字） |

---

## 8. 主要ロジック

### 時刻正規化（`normalizeTime`）
```js
// "2100" → "21:00"  "900" → "09:00"  "21:00" → "21:00"（そのまま）
function normalizeTime(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const digits = str.replace(/\D/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return str;
}
```

### 24時以上の時刻対応（`resolveDateTime` in `calendar.js`）
```js
// "2026-05-16", "25:00" → "2026-05-17T01:00:00+09:00"
function resolveDateTime(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  if (h < 24) return `${dateStr}T${timeStr}:00+09:00`;
  const extraDays = Math.floor(h / 24);
  const normalH   = h % 24;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const date = new Date(y, mo - 1, d + extraDays);
  // ...日付を繰り上げて返す
}
```

### カウントダウン自動削除ヘルパー（`index.js`）
```js
function fmtCd(content, n) { return `${content}\n-# (${n}秒後に消えます)`; }
function startCountdownDelete(interaction, content, seconds = 5) {
  // 1秒ごとにカウントを更新し、最後に deleteReply()
  for (let i = seconds - 1; i >= 1; i--) {
    setTimeout(() => interaction.editReply({ content: fmtCd(content, i) }).catch(() => {}), (seconds - i) * 1000);
  }
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}
```
- 成功メッセージ: **5秒後削除**
- エラーメッセージ: **8秒後削除**
- **適用しないケース**: `btn_prev_*` / `btn_next_*`（月切り替え。カレンダーEmbedを返すため削除しない）

### 操作ログ（Audit Log）
```js
async function sendAuditLog(action, interaction, { title, dateStr, timeStr, desc }) {
  if (!LOG_CHANNEL_ID) return;  // 未設定なら無効
  // action: "追加"(緑) / "変更"(黄) / "削除"(赤)
  // Embedに操作者名・アバター・タイムスタンプを付与
}
```
削除時は `getEvent()` で情報取得 → `deleteEvent()` の順（逆にすると情報を取れない）

### 編集フロー（`pendingEditInteractions`）
```js
const pendingEditInteractions = new Map(); // userId → interaction

// btn_edit_select: await reply → Mapに保存
pendingEditInteractions.set(interaction.user.id, interaction);

// modal_edit_: モーダル送信時にMapから取得し削除
const _prevEdit = pendingEditInteractions.get(interaction.user.id);
if (_prevEdit) {
  _prevEdit.deleteReply().catch(() => {});  // 「選んでください」メッセージを削除
  pendingEditInteractions.delete(interaction.user.id);
}
```
インタラクショントークンは15分間有効。キャンセル時はMapに残るが次回編集で上書きされる。

---

## 9. 投稿構造（チャンネル固定2件）

```
DISCORD_CHANNEL_ID チャンネル
├── 投稿1: カレンダーEmbed + [◀先月] [翌月▶] [🔄更新]
└── 投稿2: ステータスEmbed + [➕追加] [✏️編集] [🗑️削除]
```

- メッセージIDは `data/state.json` に保存。再起動後も同じメッセージを edit する
- 起動時は `run(isFirst=true)` で強制更新、その後は cron で `run(false)`
- cron 実行時はハッシュ比較で変更があった場合のみカレンダーを更新
- ステータスEmbedは毎回更新（最終同期時刻を表示するため）

---

## 10. 通知フロー

```
予定追加/編集後 → buildNoticeManageComponents(eventId) → 通知管理UI表示
（通知設定なしでも「完了」ボタンで閉じられる）

通知管理UI:
  [➕ 通知を追加] → ロール選択 / ユーザー選択 / @everyone / @here
                  → 時間選択（5分〜24時間）→ 保存 → 管理UI戻り
  [🗑️ 通知を削除] → deferUpdate後 guild.members.fetch() で実名取得
                  → セレクトメニュー表示 → 選択 → deleteNoticeEntry → 管理UI戻り
  [✅ 完了]        → カウントダウン後削除

cron（*/5分）→ checkAndFireNotices:
  今月・来月のイベントを取得 → notices.jsonと照合
  → 通知タイミングを過ぎた未送信通知を NOTIFY_CHANNEL_ID に送信
  → 送信済みは firedAt に記録
  → 予定開始から24時間経過したものは notices.json から自動削除
```

---

## 11. グレースフルシャットダウン

`SIGTERM` / `SIGINT` / `SIGHUP` 受信時:
1. ステータスEmbedを「Bot停止中」（グレー）に更新、ボタン削除
2. カレンダーのボタンを削除
3. `client.destroy()` して `process.exit(0)`
4. 10秒タイムアウト内に完了しなければ `process.exit(1)`（強制終了）

---

## 12. embed.js 主要ビルダー一覧

| 関数名 | 返り値 | 説明 |
|--------|--------|------|
| `buildCalendarEmbed(events, year, month)` | `EmbedBuilder` | カレンダー本体 |
| `buildCalendarButtons(year, month)` | `ActionRowBuilder` | ◀▶🔄 ボタン行 |
| `buildStatusEmbed(events, lastUpdated, roleName, online?)` | `EmbedBuilder` | ステータス（直近予定・件数等） |
| `buildActionButtons()` | `ActionRowBuilder` | ➕✏️🗑️ ボタン行 |
| `buildSelectMenu(events, customId, placeholder)` | `ActionRowBuilder\|null` | 予定選択メニュー（0件時null） |
| `buildRoleSelectForNotify(eventId)` | `ActionRowBuilder[]` | ロール/ユーザー選択行 |
| `buildNotifyTimeButtons(eventId, roleId, targetType?)` | `ActionRowBuilder[]` | 時間選択ボタン行 |
| `buildNoticeManageComponents(eventId)` | `{content, components}` | 通知管理UI全体 |

---

## 13. storage.js 関数一覧

| 関数 | 説明 |
|------|------|
| `loadState()` | state.json を読む |
| `saveState(partial)` | state.json に partial をマージ保存 |
| `getNoticesForEvent(eventId)` | 特定イベントの通知リスト |
| `setNoticesForEvent(eventId, notices)` | 通知リスト全体を上書き保存 |
| `deleteNoticesForEvent(eventId)` | イベントの通知設定を全削除 |
| `markNoticeFired(eventId, index)` | 指定インデックスに firedAt 記録 |
| `resetFiredForEvent(eventId)` | 全 firedAt を削除（編集時に使用） |
| `deleteNoticeEntry(eventId, index)` | 指定インデックスの通知設定を削除 |

---

## 14. 既知の制約・注意事項

- Discordインタラクショントークンは**15分**で失効。長時間かかる操作には注意
- `btn_nmgr_del_` は `guild.members.fetch()` を使うため `deferUpdate()` が必要（非同期操作前に確認応答）
- `btn_prev_*` / `btn_next_*` は ephemeral メッセージからのクリックかどうかで `interaction.update()` / `interaction.editReply()` を切り替える
- カレンダーEmbed は最大50件取得（`maxResults: 50`）、Embed説明欄は4000文字で切り捨て
- 通知の同 `minutesBefore` に対して複数メンションがあれば1メッセージにまとめる
- `GOOGLE_PRIVATE_KEY` の改行は `\\n` をそのまま .env に書けばよい（`replace(/\\n/g, "\n")` で処理済み）

---

## 15. 実装済み機能（本セッションまでの累積）

- [x] チャンネル固定2投稿（カレンダー・ステータス）
- [x] 予定CRUD（追加・編集・削除）
- [x] ロール制限（`OPERATOR_ROLE_NAME` / 管理者）
- [x] 通知設定（ロール・ユーザー・@everyone・@here、複数設定可）
- [x] 通知送信（cron, 別チャンネル対応）
- [x] 操作ログ Embed（`LOG_CHANNEL_ID` チャンネルへ色分け送信）
- [x] 月切り替え（先月・来月）
- [x] 24時以上の時刻入力対応（`2700` = 翌3時など）
- [x] ephemeral 応答のカウントダウン自動削除（成功5秒・エラー8秒）
- [x] 通知削除メニューに実際のロール名/ユーザー名を表示
- [x] ステータスEmbedの直近予定説明を常に別行に表示
- [x] 編集フロー完了時に「選んでください」メッセージを自動削除
- [x] グレースフルシャットダウン（停止中表示への切り替え）

---

## 16. 起動コマンド

```bash
cd src
node index.js
```

---

*この仕様書は 2026-05-16 時点のコードベースに基づいています。*
