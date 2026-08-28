/**
 * =====================================================================
 * 施工日報 Google Drive保存API v1.0.0【解説コメント版】
 * =====================================================================
 *
 * このGASは何をしている？
 * -------------------------------------------------------------
 * スマホ側の施工日報HTMLから送られてきた
 *
 *   1. 日報の基本情報
 *   2. 写真
 *   3. 音声ファイル（使う場合）
 *
 * を受け取り、Google Driveへ整理して保存し、
 * 最後にGoogleスプレッドシートへ「日報の目次」を1行追加するAPIです。
 *
 *
 * 全体の処理イメージ
 * -------------------------------------------------------------
 *
 * 施工日報HTML
 *      │
 *      │ action=start
 *      ▼
 * GAS：日報フォルダを作る
 *      │
 *      │ action=upload（写真ごとに複数回）
 *      ▼
 * GAS：写真をDriveへ保存
 *      │
 *      │ action=finalize
 *      ▼
 * GAS：report.jsonを作成
 *      │
 *      ├─ Google Driveに日報一式を保存
 *      └─ スプレッドシートに一覧を追加
 *
 *
 * Drive側はこんな構成になります
 * -------------------------------------------------------------
 *
 * 施工日報保管庫
 * ├─ 施工日報管理台帳（Googleスプレッドシート）
 * └─ 2026年
 *    └─ 08月
 *       └─ MD-20260829-123456-ABCD
 *          ├─ before-01.jpg
 *          ├─ cause-01.jpg
 *          ├─ after-01.jpg
 *          └─ report.json
 *
 *
 * なぜ start → upload → finalize の3段階なの？
 * -------------------------------------------------------------
 * 写真を全部まとめて1回で送るとデータが大きくなり、
 * GASの制限や通信切断の影響を受けやすくなるためです。
 *
 * まず保存先を確保し（start）、
 * 写真を1枚ずつ安全に送り（upload）、
 * 全部そろった時点で日報を確定（finalize）します。
 *
 * 途中で通信が切れても、同じ日報IDで再送すれば、
 * 未確定の途中ファイルを整理してやり直せる設計になっています。
 *
 *
 * セキュリティ面
 * -------------------------------------------------------------
 * ・appToken
 *   → 知らない人が保存APIを使えないようにする「アプリキー」
 *
 * ・sessionId
 *   → startで作った日報フォルダに対してだけ、
 *      upload / finalizeできるようにする一時的な署名
 *
 * ・フォルダ検証
 *   → 外部から勝手なGoogle DriveフォルダIDを指定されても、
 *      「施工日報保管庫」の配下でなければ拒否
 *
 * ・MIMEタイプ / サイズ検証
 *   → 想定外のファイルや巨大ファイルを拒否
 *
 *
 * 使い方
 * -------------------------------------------------------------
 * 1. このファイルをGoogle Apps Scriptへ貼り付ける
 * 2. setup() を1回実行して権限を許可する
 * 3. 実行ログに表示された appToken を安全に控える
 * 4. Webアプリとして「実行ユーザー: 自分」「アクセス: 全員」でデプロイする
 * 5. /exec URLとappTokenを施工日報HTMLの初期設定へ入力する
 *
 * ※この解説版は「コメントを増やしただけ」で、
 *   元の保存処理そのものは変更していません。
 */

// =====================================================================
// ① 基本設定
// =====================================================================
// ここは「保存API全体で共通して使う設定値」です。
// 普段はほぼ変更不要です。

const BACKEND_VERSION = '1.0.0';
// Google Driveに自動作成する一番上のフォルダ名
const ROOT_FOLDER_NAME = '施工日報保管庫';
// 日報の一覧・AI処理状況などを管理するスプレッドシート名
const SPREADSHEET_NAME = '施工日報管理台帳';
// 上記スプレッドシート内で使うシート名
const SHEET_NAME = '施工日報一覧';
// 写真・音声1ファイルあたり最大10MB。
// HTML側でも圧縮していますが、GAS側でも念のため制限します。
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 日報JSONなどの文字データが異常に巨大にならないための上限
const MAX_METADATA_CHARS = 120000;
// 1日報に紐付けられる写真・音声の合計上限
const MAX_FILES_PER_REPORT = 20;

// =====================================================================
// ② Script Propertiesに保存する設定名
// =====================================================================
// setup()で作ったDriveフォルダID等を、コードに直書きせず
// Apps Scriptの「スクリプト プロパティ」へ保存しています。

const PROP_ROOT_FOLDER_ID = 'ROOT_FOLDER_ID';
const PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
const PROP_TOKEN_HASH = 'APP_TOKEN_SHA256';
const PROP_SESSION_SECRET = 'SESSION_SECRET';

// =====================================================================
// ③ 管理スプレッドシートの列定義
// =====================================================================
// finalize後、この順番で1件＝1行として保存します。
// AI記事化を追加するときは「AI状態」「記事状態」などを利用できます。

const SHEET_HEADERS = [
  '日報ID', '受付日時', '施工日時', '案件番号', '施工担当', '公開可能地域', '工事カテゴリ',
  'お客様の言葉', '症状の条件', '緊急度', '調査箇所・確認内容', '確認できた原因', '原因の確度',
  '提示した選択肢', '実際に行った施工', '使用部材・メーカー・型番', '作業時間（分）', '税込総額（円）',
  '施工後の確認結果', '今後の注意点', '地域公開', '料金公開', '写真公開', '掲載説明済み', '個人情報確認済み',
  '音声ファイルID', '写真ファイルID一覧', '写真枚数', 'DriveフォルダID', 'DriveフォルダURL',
  'AI状態', '記事状態', 'クライアント版', '保存API版'
];

/**
 * =====================================================================
 * setup()
 * =====================================================================
 * 最初に1回だけ手動実行する初期設定関数です。
 *
 * やっていること：
 * ① Google Driveに「施工日報保管庫」を作る
 * ② その中に「施工日報管理台帳」スプレッドシートを作る
 * ③ 管理シートの見出しを作る
 * ④ sessionId作成用の秘密文字列を作る
 * ⑤ HTMLからアクセスするためのappTokenを発行する
 *
 * 一度作成したIDはScript Propertiesへ保存するため、
 * setup()を再実行しても同じ保存先を再利用します。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();

  let rootFolder;
  const existingRootId = props.getProperty(PROP_ROOT_FOLDER_ID);
  if (existingRootId) {
    rootFolder = DriveApp.getFolderById(existingRootId);
  } else {
    rootFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
    props.setProperty(PROP_ROOT_FOLDER_ID, rootFolder.getId());
  }

  let spreadsheet;
  const existingSheetId = props.getProperty(PROP_SPREADSHEET_ID);
  if (existingSheetId) {
    spreadsheet = SpreadsheetApp.openById(existingSheetId);
  } else {
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_NAME);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(rootFolder);
    props.setProperty(PROP_SPREADSHEET_ID, spreadsheet.getId());
  }

  ensureSheet_(spreadsheet);

  if (!props.getProperty(PROP_SESSION_SECRET)) {
    props.setProperty(PROP_SESSION_SECRET, Utilities.getUuid() + Utilities.getUuid());
  }

  let appToken = null;
  if (!props.getProperty(PROP_TOKEN_HASH)) {
    appToken = generateAppToken_();
    props.setProperty(PROP_TOKEN_HASH, hashToken_(appToken));
  }

  const result = {
    ok: true,
    message: appToken
      ? '初期セットアップが完了しました。appTokenはこの実行ログで一度だけ確認できます。'
      : '保存先は設定済みです。既存appTokenは再表示できません。必要なら rotateAppToken() を実行してください。',
    appToken: appToken || '(設定済み・非表示)',
    rootFolderId: rootFolder.getId(),
    rootFolderUrl: rootFolder.getUrl(),
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    backendVersion: BACKEND_VERSION
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * rotateAppToken()
 * -------------------------------------------------------------
 * appToken（アプリキー）を作り直します。
 *
 * 例えば、
 * ・キーを他人に見られた
 * ・施工担当の端末を紛失した
 * ・全端末のキーを一斉に変更したい
 *
 * といった時に使います。
 *
 * 実行すると「古いキーはすぐ使えなくなる」ので注意。
 */
function rotateAppToken() {
  const token = generateAppToken_();
  PropertiesService.getScriptProperties().setProperty(PROP_TOKEN_HASH, hashToken_(token));
  const result = {
    ok: true,
    message: 'アプリキーを再発行しました。各端末の初期設定を更新してください。',
    appToken: token
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * getSetupInfo()
 * -------------------------------------------------------------
 * 現在どのDriveフォルダ・スプレッドシートを使っているか
 * 確認するための管理用関数です。
 *
 * セキュリティのためappTokenそのものは表示しません。
 */
function getSetupInfo() {
  const props = PropertiesService.getScriptProperties();
  const rootId = props.getProperty(PROP_ROOT_FOLDER_ID);
  const sheetId = props.getProperty(PROP_SPREADSHEET_ID);
  const result = {
    configured: Boolean(rootId && sheetId && props.getProperty(PROP_TOKEN_HASH)),
    rootFolderId: rootId || '',
    rootFolderUrl: rootId ? DriveApp.getFolderById(rootId).getUrl() : '',
    spreadsheetId: sheetId || '',
    spreadsheetUrl: sheetId ? SpreadsheetApp.openById(sheetId).getUrl() : '',
    backendVersion: BACKEND_VERSION
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * doGet()
 * -------------------------------------------------------------
 * GASのWebアプリURL（.../exec）を普通にブラウザで開いた時に
 * 「APIは動いていますよ」と表示するだけの確認画面です。
 *
 * 日報保存の本処理はdoPost()側で行います。
 */
function doGet() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>施工日報保存API</title></head><body style="font-family:sans-serif;padding:32px;line-height:1.7">' +
    '<h1>施工日報保存API</h1><p>稼働中です。</p><p>Backend version: ' + escapeHtml_(BACKEND_VERSION) + '</p>' +
    '<p>このURLを施工日報HTMLの初期設定へ登録してください。</p></body></html>'
  ).setTitle('施工日報保存API');
}

/**
 * =====================================================================
 * doPost(e)
 * =====================================================================
 * 日報HTMLから送られてくるリクエストの「総合受付」です。
 *
 * HTMLはactionという値を付けて送ってきます。
 *
 * action=ping
 *   → GASとの接続確認
 *
 * action=start
 *   → 日報保存用フォルダを作る
 *
 * action=upload
 *   → 写真・音声を1ファイルずつ保存
 *
 * action=finalize
 *   → 日報を確定してreport.jsonと台帳を作る
 *
 * まずappTokenをチェックしてから処理するため、
 * 正しいキーを知らないアクセスはここで止まります。
 */
function doPost(e) {
  const requestId = sanitizeSimple_(e && e.parameter && e.parameter.requestId, 120) || 'unknown';
  try {
    ensureConfigured_();
    const params = (e && e.parameter) || {};
    // まずアプリキーを確認。ここを通過しないとDrive操作には進めません。
    validateToken_(params.appToken);

    // HTMLが「何をしたいのか」を action で判定します。
    const action = sanitizeSimple_(params.action, 30);

    let result;
    switch (action) {
      case 'ping':
        result = { ok: true, version: BACKEND_VERSION, timestamp: new Date().toISOString() };
        break;
      case 'start':
        result = startUpload_(params);
        break;
      case 'upload':
        result = uploadFile_(params);
        break;
      case 'finalize':
        result = finalizeReport_(params);
        break;
      default:
        throw new Error('不明なactionです。');
    }
    return postMessageResponse_(requestId, result);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return postMessageResponse_(requestId, {
      ok: false,
      error: userSafeError_(error)
    });
  }
}

/**
 * =====================================================================
 * startUpload_()
 * =====================================================================
 * 1件の日報保存を「開始」する処理です。
 *
 * 施工日時から
 *   施工日報保管庫 → yyyy年 → MM月 → 日報ID
 * のフォルダを作ります。
 *
 * report.jsonがすでにある場合
 * → その日報は保存完了済みなので二重登録を拒否。
 *
 * _uploading.json
 * → 「この日報は今アップロード途中ですよ」という印です。
 *
 * 最後にsessionIdを発行します。
 * 以降のupload / finalizeでは、このsessionIdがないと進めません。
 */
function startUpload_(params) {
  const reportId = validateReportId_(params.reportId);
  const date = parseWorkDate_(params.workDateTime);
  const root = DriveApp.getFolderById(getRequiredProperty_(PROP_ROOT_FOLDER_ID));
  // 施工日時を基準に「2026年 → 08月」のように自動整理します。
  const yearFolder = getOrCreateFolder_(root, Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy年'));
  const monthFolder = getOrCreateFolder_(yearFolder, Utilities.formatDate(date, 'Asia/Tokyo', 'MM月'));
  let reportFolder = getOrCreateFolder_(monthFolder, reportId);

  if (reportFolder.getFilesByName('report.json').hasNext()) {
    throw new Error('この日報IDは既に保存済みです。新しい日報IDで送信してください。');
  }

  // 途中失敗からの再送時に古い添付が残らないよう、未確定フォルダを空にします。
  const staleFiles = reportFolder.getFiles();
  while (staleFiles.hasNext()) staleFiles.next().setTrashed(true);

  replaceTextFile_(reportFolder, '_uploading.json', JSON.stringify({
    reportId: reportId,
    startedAt: new Date().toISOString(),
    clientVersion: sanitizeSimple_(params.clientVersion, 40)
  }, null, 2), 'application/json');

  const sessionId = createSessionId_(reportId, reportFolder.getId());
  return {
    ok: true,
    reportId: reportId,
    folderId: reportFolder.getId(),
    folderUrl: reportFolder.getUrl(),
    sessionId: sessionId,
    version: BACKEND_VERSION
  };
}

/**
 * =====================================================================
 * uploadFile_()
 * =====================================================================
 * 写真・音声を「1ファイルずつ」Google Driveへ保存します。
 *
 * HTML側からはファイルをBase64文字列にして送っています。
 * GAS側では、
 *
 * Base64文字列
 *   ↓
 * 元のバイトデータへ戻す
 *   ↓
 * Blobに変換
 *   ↓
 * Google DriveへcreateFile()
 *
 * という流れです。
 *
 * 保存前に
 * ・sessionIdが正しいか
 * ・保存先フォルダが正しいか
 * ・画像/音声として許可された形式か
 * ・10MB以下か
 * をチェックしています。
 */
function uploadFile_(params) {
  const reportId = validateReportId_(params.reportId);
  const folderId = sanitizeSimple_(params.folderId, 120);
  validateSession_(reportId, folderId, params.sessionId);

  const folder = DriveApp.getFolderById(folderId);
  assertReportFolder_(folder, reportId);
  if (folder.getFilesByName('report.json').hasNext()) {
    throw new Error('保存済み日報にはファイルを追加できません。');
  }

  const fileName = sanitizeFileName_(params.fileName);
  const mimeType = sanitizeMimeType_(params.mimeType);
  const kind = sanitizeSimple_(params.fileKind, 30);
  if (!(kind === 'audio' || kind === 'photo')) throw new Error('fileKindが不正です。');
  validateMimeForKind_(mimeType, kind);

  // ブラウザからはバイナリファイルをBase64文字列として受け取ります。
  const base64 = String(params.base64 || '');
  if (!base64) throw new Error('ファイルデータが空です。');
  if (base64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64) throw new Error('ファイルが10MBを超えています。');

  let bytes;
  try {
    bytes = Utilities.base64DecodeWebSafe(padBase64_(base64));
  } catch (error) {
    throw new Error('ファイルデータを復元できませんでした。');
  }
  if (bytes.length > MAX_FILE_BYTES) throw new Error('ファイルが10MBを超えています。');

  removeFilesByName_(folder, fileName);
  // 元の写真/音声へ戻したデータをBlob化してDriveへ保存。
  const blob = Utilities.newBlob(bytes, mimeType, fileName);
  const file = folder.createFile(blob);
  file.setDescription(JSON.stringify({
    reportId: reportId,
    kind: kind,
    category: sanitizeSimple_(params.fileCategory, 40),
    uploadedAt: new Date().toISOString()
  }));

  return {
    ok: true,
    fileId: file.getId(),
    fileName: file.getName(),
    size: file.getSize()
  };
}

/**
 * =====================================================================
 * finalizeReport_()
 * =====================================================================
 * 写真のアップロードが全部終わった後に呼ばれる、
 * 「日報を正式に保存完了にする」処理です。
 *
 * やっていること：
 * ① HTMLから届いた日報本文(metadataJson)を読み込む
 * ② アップロード済みファイル一覧(manifestJson)を読み込む
 * ③ 必須項目・ファイルの整合性を確認
 * ④ 日報一式をreport.jsonとしてDriveへ保存
 * ⑤ _uploading.jsonを削除
 * ⑥ 管理スプレッドシートへ1行追加
 *
 * report.jsonができた時点を「正式保存済み」としています。
 *
 * 将来AI記事化をするときは、このreport.jsonを読めば
 * 日報情報と写真ファイルIDをまとめて取得できます。
 */
function finalizeReport_(params) {
  const reportId = validateReportId_(params.reportId);
  const folderId = sanitizeSimple_(params.folderId, 120);
  validateSession_(reportId, folderId, params.sessionId);

  const folder = DriveApp.getFolderById(folderId);
  assertReportFolder_(folder, reportId);

  const metadataRaw = String(params.metadataJson || '');
  const manifestRaw = String(params.manifestJson || '[]');
  if (!metadataRaw || metadataRaw.length > MAX_METADATA_CHARS) throw new Error('日報データのサイズが不正です。');
  if (manifestRaw.length > MAX_METADATA_CHARS) throw new Error('ファイル一覧のサイズが不正です。');

  const metadata = parseJsonObject_(metadataRaw, '日報データ');
  const manifest = parseJsonArray_(manifestRaw, 'ファイル一覧');
  if (metadata.reportId !== reportId) throw new Error('日報IDが一致しません。');
  if (manifest.length > MAX_FILES_PER_REPORT) throw new Error('ファイル数が上限を超えています。');
  validateRequiredMetadata_(metadata);
  validateManifestFiles_(folder, manifest);

  const submittedAt = new Date().toISOString();
  const report = {
    schemaVersion: '1.0',
    reportId: reportId,
    submittedAt: submittedAt,
    metadata: metadata,
    files: manifest,
    storage: {
      provider: 'Google Drive',
      folderId: folder.getId(),
      folderUrl: folder.getUrl()
    },
    processing: {
      aiStatus: 'WAITING',
      articleStatus: 'NOT_CREATED'
    }
  };

  // このreport.jsonが「この日報の原本」です。
  // AI記事化するときも、基本的にはこのJSONを起点にできます。
  replaceTextFile_(folder, 'report.json', JSON.stringify(report, null, 2), 'application/json');
  removeFilesByName_(folder, '_uploading.json');
  folder.setDescription('施工日報 ' + reportId + ' / 保存日時 ' + submittedAt);

  // Driveへの保存完了後、検索しやすいようスプレッドシートにも目次を作ります。
  upsertSheetRow_(metadata, manifest, folder, submittedAt);

  return {
    ok: true,
    reportId: reportId,
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
    spreadsheetUrl: SpreadsheetApp.openById(getRequiredProperty_(PROP_SPREADSHEET_ID)).getUrl()
  };
}

/**
 * validateRequiredMetadata_()
 * -------------------------------------------------------------
 * 日報の必須項目チェックです。
 *
 * 「困りごと」「原因」「施工内容」などが空のまま
 * Driveへ正式保存されるのを防ぎます。
 *
 * VER2のHTMLでは旧項目名へ互換変換して送っているため、
 * GAS側はこの既存項目名のまま動かせます。
 */
function validateRequiredMetadata_(metadata) {
  const required = [
    'reportId', 'workDateTime', 'caseNumber', 'worker', 'publicArea', 'category',
    'customerWords', 'inspectedPoints', 'confirmedCause', 'workPerformed', 'workResult'
  ];
  required.forEach(function(key) {
    if (!String(metadata[key] == null ? '' : metadata[key]).trim()) {
      throw new Error('必須項目が不足しています: ' + key);
    }
  });
  if (!Number.isFinite(Number(metadata.durationMinutes)) || Number(metadata.durationMinutes) <= 0) {
    throw new Error('作業時間が不正です。');
  }
  if (!Number.isFinite(Number(metadata.priceTaxIncluded)) || Number(metadata.priceTaxIncluded) < 0) {
    throw new Error('税込総額が不正です。');
  }
  if (!metadata.publicationPermissions || metadata.publicationPermissions.privacyChecked !== true) {
    throw new Error('個人情報確認が完了していません。');
  }
}

/**
 * validateManifestFiles_()
 * -------------------------------------------------------------
 * finalize時に指定された写真IDが、
 * 本当に「この日報フォルダ内」に存在するか確認します。
 *
 * 外部から別のDriveファイルIDを勝手に混ぜられないための
 * セキュリティ・整合性チェックです。
 */
function validateManifestFiles_(folder, manifest) {
  manifest.forEach(function(item) {
    if (!item || !item.id || !item.name) throw new Error('ファイル一覧が不正です。');
    const file = DriveApp.getFileById(String(item.id));
    const parents = file.getParents();
    let inFolder = false;
    while (parents.hasNext()) {
      if (parents.next().getId() === folder.getId()) {
        inFolder = true;
        break;
      }
    }
    if (!inFolder) throw new Error('日報フォルダ外のファイルが指定されています。');
    if (file.getName() !== String(item.name)) throw new Error('ファイル名が一致しません。');
  });
}

/**
 * =====================================================================
 * upsertSheetRow_()
 * =====================================================================
 * Googleスプレッドシートの「施工日報一覧」へ1行保存します。
 *
 * Drive
 *   → 日報の原本・写真を保管する倉庫
 *
 * Spreadsheet
 *   → 日報を探したりAI処理状況を確認する目次
 *
 * という役割分担です。
 *
 * 同じ日報IDがすでに一覧にある場合は、
 * 新しい行を増やさず既存行を更新します。
 *
 * LockServiceを使っている理由：
 * 複数の施工担当がほぼ同時に送信した場合、
 * スプレッドシートへの書き込みがぶつからないようにするためです。
 */
function upsertSheetRow_(metadata, manifest, folder, submittedAt) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(getRequiredProperty_(PROP_SPREADSHEET_ID));
    const sheet = ensureSheet_(spreadsheet);
    const permissions = metadata.publicationPermissions || {};
    const audio = manifest.find(function(item) { return item.kind === 'audio'; });
    const photos = manifest.filter(function(item) { return item.kind === 'photo'; });
    const photoIds = photos.map(function(item) { return item.id; });

    const row = [
      metadata.reportId,
      submittedAt,
      metadata.workDateTime,
      safeCell_(metadata.caseNumber),
      safeCell_(metadata.worker),
      safeCell_(metadata.publicArea),
      safeCell_(metadata.category),
      safeCell_(metadata.customerWords),
      safeCell_(metadata.symptomCondition),
      safeCell_(metadata.urgency),
      safeCell_(metadata.inspectedPoints),
      safeCell_(metadata.confirmedCause),
      safeCell_(metadata.causeCertainty),
      safeCell_(metadata.optionsProposed),
      safeCell_(metadata.workPerformed),
      safeCell_(metadata.partsUsed),
      Number(metadata.durationMinutes),
      Number(metadata.priceTaxIncluded),
      safeCell_(metadata.workResult),
      safeCell_(metadata.futureAdvice),
      permissions.area === true,
      permissions.price === true,
      permissions.photos === true,
      permissions.customerExplanation === true,
      permissions.privacyChecked === true,
      audio ? audio.id : '',
      JSON.stringify(photoIds),
      photos.length,
      folder.getId(),
      folder.getUrl(),
      '未処理',
      '未作成',
      safeCell_(metadata.clientVersion),
      BACKEND_VERSION
    ];

    let targetRow = sheet.getLastRow() + 1;
    if (sheet.getLastRow() >= 2) {
      const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
        .createTextFinder(metadata.reportId)
        .matchEntireCell(true)
        .findNext();
      if (match) targetRow = match.getRow();
    }
    sheet.getRange(targetRow, 1, 1, SHEET_HEADERS.length).setValues([row]);
    sheet.getRange(targetRow, 17, 1, 2).setNumberFormat('#,##0');
  } finally {
    lock.releaseLock();
  }
}

/**
 * ensureSheet_()
 * -------------------------------------------------------------
 * 「施工日報一覧」シートがなければ自動作成し、
 * 1行目の見出し・色・列幅なども整えます。
 *
 * setup()時だけでなく、保存時にも呼べるようになっています。
 */
function ensureSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    sheet = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0] : spreadsheet.insertSheet();
    sheet.setName(SHEET_NAME);
  }

  const currentHeaders = sheet.getLastColumn() >= SHEET_HEADERS.length
    ? sheet.getRange(1, 1, 1, SHEET_HEADERS.length).getValues()[0]
    : [];
  const needsHeaders = SHEET_HEADERS.some(function(header, i) { return currentHeaders[i] !== header; });
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length)
      .setBackground('#172033')
      .setFontColor('#ffffff')
      .setFontWeight('bold')
      .setWrap(true);
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.autoResizeColumns(1, SHEET_HEADERS.length);
    [8, 9, 11, 12, 14, 15, 16, 19, 20].forEach(function(col) { sheet.setColumnWidth(col, 260); });
    sheet.setColumnWidth(30, 260);
  }
  return sheet;
}

/**
 * assertReportFolder_()
 * -------------------------------------------------------------
 * 指定されたフォルダが
 * ・名前＝日報IDになっているか
 * ・「施工日報保管庫」の配下にあるか
 * を確認します。
 *
 * ユーザーから渡されたfolderIdを無条件に信用しないための処理です。
 */
function assertReportFolder_(folder, reportId) {
  if (folder.getName() !== reportId) throw new Error('日報フォルダが一致しません。');
  const rootId = getRequiredProperty_(PROP_ROOT_FOLDER_ID);
  let current = folder;
  for (let depth = 0; depth < 6; depth++) {
    if (current.getId() === rootId) return;
    const parents = current.getParents();
    if (!parents.hasNext()) break;
    current = parents.next();
  }
  throw new Error('許可されていない保存先です。');
}

/**
 * getOrCreateFolder_()
 * -------------------------------------------------------------
 * 同名フォルダがあれば再利用、なければ新規作成する小さな共通関数。
 */
function getOrCreateFolder_(parent, name) {
  const iterator = parent.getFoldersByName(name);
  return iterator.hasNext() ? iterator.next() : parent.createFolder(name);
}

/**
 * replaceTextFile_()
 * -------------------------------------------------------------
 * report.jsonや_uploading.jsonを「同名があれば置き換えて」保存します。
 */
function replaceTextFile_(folder, name, content, mimeType) {
  removeFilesByName_(folder, name);
  return folder.createFile(Utilities.newBlob(content, mimeType || 'text/plain', name));
}

/**
 * removeFilesByName_()
 * -------------------------------------------------------------
 * 指定名の既存ファイルをゴミ箱へ移動します。
 * Google Drive上で同名ファイルが増殖するのを防ぎます。
 */
function removeFilesByName_(folder, name) {
  const files = folder.getFilesByName(name);
  while (files.hasNext()) files.next().setTrashed(true);
}

/**
 * createSessionId_()
 * -------------------------------------------------------------
 * reportId + folderIdを秘密鍵でHMAC署名してsessionIdを作ります。
 *
 * 「startでGAS自身が発行した組み合わせですよ」
 * と証明するための簡易署名です。
 */
function createSessionId_(reportId, folderId) {
  const secret = getRequiredProperty_(PROP_SESSION_SECRET);
  const signature = Utilities.computeHmacSha256Signature(reportId + '|' + folderId, secret);
  return Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '');
}

/**
 * validateSession_()
 * -------------------------------------------------------------
 * upload / finalize時のsessionIdが正しいか確認します。
 */
function validateSession_(reportId, folderId, sessionId) {
  const expected = createSessionId_(reportId, folderId);
  if (!constantTimeEquals_(expected, String(sessionId || ''))) throw new Error('アップロードセッションが無効です。');
}

/**
 * validateToken_()
 * -------------------------------------------------------------
 * HTMLに設定したappTokenが正しいか確認します。
 *
 * tokenそのものはScript Propertiesへ保存せず、
 * SHA-256でハッシュ化した値だけ保存しています。
 */
function validateToken_(token) {
  const expected = getRequiredProperty_(PROP_TOKEN_HASH);
  const actual = hashToken_(String(token || ''));
  if (!constantTimeEquals_(expected, actual)) throw new Error('アプリキーが正しくありません。');
}

/**
 * hashToken_()
 * -------------------------------------------------------------
 * appTokenをSHA-256でハッシュ化します。
 */
function hashToken_(token) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

/**
 * constantTimeEquals_()
 * -------------------------------------------------------------
 * 文字列比較の処理時間から秘密情報を推測されにくくするため、
 * なるべく一定時間になるよう比較します。
 */
function constantTimeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  return diff === 0;
}

/**
 * generateAppToken_()
 * -------------------------------------------------------------
 * UUIDを2個つないで長いランダムなappTokenを作ります。
 */
function generateAppToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/**
 * validateReportId_()
 * -------------------------------------------------------------
 * 日報IDが想定形式になっているかチェックします。
 *
 * 例：
 * MD-20260829-123456-ABCD
 */
function validateReportId_(value) {
  const reportId = sanitizeSimple_(value, 80);
  if (!/^MD-\d{8}-\d{6}-[A-Z0-9]{4,16}$/.test(reportId)) throw new Error('日報IDの形式が不正です。');
  return reportId;
}

/**
 * parseWorkDate_()
 * -------------------------------------------------------------
 * HTMLから届いた施工日時をDateへ変換します。
 * 年/月フォルダを決めるために使用します。
 */
function parseWorkDate_(value) {
  const text = String(value || '');
  const date = text ? new Date(text) : new Date();
  if (isNaN(date.getTime())) return new Date();
  return date;
}

/**
 * sanitizeFileName_()
 * -------------------------------------------------------------
 * ファイル名として危険・不正な記号を「_」へ置き換えます。
 */
function sanitizeFileName_(value) {
  const name = String(value || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 140);
  if (!name || name === '.' || name === '..') throw new Error('ファイル名が不正です。');
  return name;
}

/**
 * sanitizeMimeType_()
 * -------------------------------------------------------------
 * MIMEタイプ（image/jpeg等）の形式を整えます。
 */
function sanitizeMimeType_(value) {
  const mime = String(value || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return 'application/octet-stream';
  return mime;
}

/**
 * validateMimeForKind_()
 * -------------------------------------------------------------
 * photoなのに実行ファイル等が送られてこないよう、
 * 許可された画像・音声形式だけ通します。
 */
function validateMimeForKind_(mime, kind) {
  if (kind === 'photo' && !/^image\/(jpeg|jpg|png|webp)$/.test(mime)) {
    throw new Error('対応していない画像形式です。');
  }
  if (kind === 'audio' && !(/^audio\//.test(mime) || mime === 'video/mp4' || mime === 'application/octet-stream')) {
    throw new Error('対応していない音声形式です。');
  }
}

/**
 * padBase64_()
 * -------------------------------------------------------------
 * Base64を正しくデコードするため末尾の「=」を補います。
 */
function padBase64_(value) {
  const remainder = value.length % 4;
  return remainder ? value + '='.repeat(4 - remainder) : value;
}

/**
 * parseJsonObject_() / parseJsonArray_()
 * -------------------------------------------------------------
 * HTMLから文字列として届いたJSONを安全にJavaScriptデータへ戻します。
 */
function parseJsonObject_(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) { throw new Error(label + 'を読み取れません。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(label + 'が不正です。');
  return parsed;
}

function parseJsonArray_(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) { throw new Error(label + 'を読み取れません。'); }
  if (!Array.isArray(parsed)) throw new Error(label + 'が不正です。');
  return parsed;
}

/**
 * sanitizeSimple_()
 * -------------------------------------------------------------
 * 制御文字を除去し、最大文字数を制限する共通処理です。
 */
function sanitizeSimple_(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength || 200);
}

/**
 * safeCell_()
 * -------------------------------------------------------------
 * スプレッドシートへ書く文字列が「=」等から始まる場合、
 * 数式として実行されないよう先頭へ'を付けます。
 *
 * CSV/スプレッドシート式インジェクション対策です。
 */
function safeCell_(value) {
  const text = String(value == null ? '' : value).slice(0, 50000);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

/**
 * ensureConfigured_()
 * -------------------------------------------------------------
 * setup()が済んでいるか確認します。
 * 必須設定がなければAPI処理を止めます。
 */
function ensureConfigured_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_ROOT_FOLDER_ID) || !props.getProperty(PROP_SPREADSHEET_ID) || !props.getProperty(PROP_TOKEN_HASH)) {
    throw new Error('GASのsetup()が完了していません。');
  }
}

/**
 * getRequiredProperty_()
 * -------------------------------------------------------------
 * Script Propertiesから必須設定を取得します。
 * なければエラーにして、曖昧なまま処理を続けません。
 */
function getRequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('必要な設定がありません: ' + key);
  return value;
}

/**
 * userSafeError_()
 * -------------------------------------------------------------
 * HTML側へ返すエラー文を短く安全な文字列へ整えます。
 */
function userSafeError_(error) {
  const message = error && error.message ? String(error.message) : 'サーバー処理に失敗しました。';
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

/**
 * =====================================================================
 * postMessageResponse_()
 * =====================================================================
 * ここは少し特殊です。
 *
 * 外部サイトのHTML → GAS WebアプリへPOSTすると、
 * CORS等の都合で普通のfetchレスポンスとして扱いにくいため、
 * hidden iframeへGASのHTMLレスポンスを読み込ませています。
 *
 * GASが返したページ内で
 *
 *   window.top.postMessage(...)
 *
 * を実行し、親の日報HTMLへ結果を返しています。
 *
 * つまり、
 *
 * 日報HTML
 *   ↓ POST
 * hidden iframe（GAS）
 *   ↓ postMessage
 * 日報HTMLへ結果通知
 *
 * という橋渡しをしています。
 */
function postMessageResponse_(requestId, payload) {
  const response = Object.assign({
    source: 'massugu-report-backend',
    requestId: requestId,
    backendVersion: BACKEND_VERSION
  }, payload || {});
  const json = JSON.stringify(response).replace(/</g, '\\u003c').replace(/-->/g, '--\\>');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<script>(function(){var p=' + json + ';' +
    'try{if(window.top){window.top.postMessage(p,"*");}}catch(e){}' +
    'try{if(window.parent&&window.parent!==window.top){window.parent.postMessage(p,"*");}}catch(e){}' +
    '})();<\/script><p style="font-family:sans-serif;font-size:12px">処理が完了しました。</p></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * escapeHtml_()
 * -------------------------------------------------------------
 * doGet()の確認画面などでHTMLへ文字列を埋め込む際、
 * < > " ' & をエスケープして安全に表示します。
 */
function escapeHtml_(value) {
  return String(value).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}
