/**
 * 卓球大会ポータル - エントリポイント / 定数 / スプレッドシートメニュー
 */

const SHEET = {
  SETTINGS: '設定',
  PLAYERS: '参加者',
  LEAGUES: 'リーグ',
  MATCHES: '試合',
  STANDINGS: '順位',
  TOUR: 'トーナメント',
};

const STATUS = {
  NONE: '未実施',
  PROGRESS: '試合中',
  DONE: '終了',
};

/** 画面の下に表示するバージョン（デプロイが更新されているかの確認用） */
const APP_VERSION = '3.0（トーナメント）';

/** 1試合で記録できる最大セット数（7セットマッチまで対応） */
const MAX_SETS = 7;

/** キャッシュ保持秒数（保存時には即時に作り直すので、これは安全弁） */
const CACHE_TTL = 600;

/** 試合シートの列（0始まり） */
const MCOL = {
  ID: 0,
  LEAGUE: 1,
  NO: 2,
  P1: 3,
  N1: 4,
  P2: 5,
  N2: 6,
  STATUS: 7,
  BEST_OF: 8,
  C1: 9,
  C2: 10,
  WINNER: 11,
  SET0: 12, // 第1セット 〜 第7セット: 12..18
  UPDATED: 19,
  VER: 20,
};
const MATCH_HEADERS = [
  '試合ID', 'リーグ', '試合番号', '選手1番号', '選手1名前', '選手2番号', '選手2名前',
  '状態', 'セット数', '選手1獲得セット', '選手2獲得セット', '勝者番号',
  '第1セット', '第2セット', '第3セット', '第4セット', '第5セット', '第6セット', '第7セット',
  '更新日時', '版',
];

/* ------------------------------------------------------------------ */
/* Web アプリ                                                          */
/* ------------------------------------------------------------------ */

function doGet() {
  const title = '卓球大会ポータル';
  const t = HtmlService.createTemplateFromFile('Index');
  t.version = APP_VERSION;
  return t
    .evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * 初回に Apps Script エディタから1回だけ実行して、権限（スプレッドシートの作成・編集、トリガー）を承認する。
 */
function authorize() {
  ScriptApp.getProjectTriggers();
  CacheService.getScriptCache().get('x');
  PropertiesService.getScriptProperties().getKeys();
  if (false) SpreadsheetApp.create('authorize'); // スコープ検出用（実行はされない）
  console.log('承認が完了しました。ウェブアプリとしてデプロイしてください。');
}

/** HTML テンプレートから他ファイルを読み込む */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ------------------------------------------------------------------ */
/* スプレッドシートのメニュー                                          */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏓 卓球大会')
    .addItem('初期セットアップ（シート作成）', 'menuSetup')
    .addItem('テスト用のサンプル選手を追加', 'menuAddSamplePlayers')
    .addSeparator()
    .addItem('くじ番号を自動割当（参加・支払済みで未記入の選手）', 'menuAutoAssign')
    .addItem('リーグ戦作成', 'menuCreateLeagues')
    .addSeparator()
    .addItem('順位シートを更新', 'menuExportStandings')
    .addItem('Web表示のキャッシュをクリア', 'menuClearCache')
    .addToUi();
}

/**
 * シートを手で編集したら Web 側のキャッシュを破棄する（単純トリガー）。
 * 参加確認・支払確認・くじ番号・名前の修正などがすぐ反映されるように。
 */
function onEdit() {
  try {
    clearCache_();
  } catch (err) {
    // 単純トリガーでは失敗しても無視
  }
}

function menuSetup() {
  setupSheets_();
  SpreadsheetApp.getUi().alert(
    'セットアップが完了しました。\n\n' +
      '1. 「参加者」シートに選手名を入力してください。\n' +
      '2. 「設定」シートの管理者パスワードを変更してください（初期値: admin）。\n' +
      '3. Apps Script エディタで「デプロイ > 新しいデプロイ > ウェブアプリ」を実行してください。'
  );
}

function menuAddSamplePlayers() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('テスト用に 18 名のサンプル選手（参加・支払済み、くじ番号付き）を追加します。よろしいですか？', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  addSamplePlayers_(18);
  ui.alert('サンプル選手を追加しました。');
}

function menuAutoAssign() {
  const res = autoAssignNumbers_();
  SpreadsheetApp.getUi().alert(
    res.assigned.length
      ? res.assigned.length + ' 名にくじ番号を割り当てました。\n\n' + res.assigned.map(function (a) { return a.num + ': ' + a.name; }).join('\n')
      : '割り当てが必要な選手はいませんでした。'
  );
}

function menuCreateLeagues() {
  const ui = SpreadsheetApp.getUi();
  const s = getSettings_();
  const r = ui.alert(
    'リーグ戦作成',
    '「設定」シートの内容（リーグ数: ' + s.leagueCount + '、リーグ戦: ' + s.leagueSets + 'セットマッチ）で、' +
      '参加・支払済みでくじ番号のある選手をランダムにリーグへ振り分けます。\nよろしいですか？',
    ui.ButtonSet.OK_CANCEL
  );
  if (r !== ui.Button.OK) return;
  let res = createLeagues_(s, false);
  if (res.needConfirm) {
    const r2 = ui.alert(
      '確認',
      '既に ' + res.resultCount + ' 試合の結果が入力されています。作り直すと結果はすべて消えます。本当に作り直しますか？',
      ui.ButtonSet.OK_CANCEL
    );
    if (r2 !== ui.Button.OK) return;
    res = createLeagues_(s, true);
  }
  ui.alert('リーグ戦を作成しました。\n\n' + res.summary.map(function (g) { return 'リーグ' + g.league + ': ' + g.count + '名 / ' + g.matches + '試合'; }).join('\n'));
}

function menuExportStandings() {
  const snap = buildSnapshot_();
  putSnapshotCache_(snap);
  writeStandingsSheet_(snap);
  SpreadsheetApp.getUi().alert('「順位」シートを更新しました。');
}

function menuClearCache() {
  clearCache_();
  SpreadsheetApp.getUi().alert('キャッシュをクリアしました。');
}
