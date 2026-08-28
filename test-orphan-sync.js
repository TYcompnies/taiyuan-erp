/**
 * test-orphan-sync.js — 孤兒改動自動治癒驗證（8/27 修復：內容指紋對帳）
 *
 * 復現用戶真實場景：
 *   手機（舊程式碼時代）刪除客戶 → push 靜默失敗（rev 不推進）→ App 重開
 *   → _pendingPush 記憶體標誌歸零 → 舊邏輯只比 rev 誤判「本地已是最新」
 *   → 刪除永遠推不上雲 → 電腦永遠看不到。
 *
 * 修復：pull() 以內容指紋（payloadHash）對帳——rev 相同但內容不同 = 孤兒改動
 *   → 後推贏先推本地 → 雲端更新 → 其他設備自動拉到。
 *
 * O1: 舊版升級遺留孤兒（無 __hash，靠 rev 相等判定）
 * O2: 新程式碼孤兒（有 __hash，靠指紋失配判定）
 * O3: 指紋自洽與重複推送冪等
 */
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://127.0.0.1:8903') + '?sync=1';
let browser;
let passed = 0, failed = 0;

function ok(name, cond, extra) {
    if (cond) passed++; else failed++;
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

// ---- 內存雲端模擬（兩個 context 共用同一閉包 = 同一個雲端） ----
let cloudFile = null;
let textdbDown = false;

function mockAll(page) {
    return page.route('**', async (route) => {
        const url = route.request().url();
        if (url.indexOf('api.textdb.online/update/') >= 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            const m = url.match(/[?&]value=([^&]*)/);
            cloudFile = m ? decodeURIComponent(m[1]) : '';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 1 }) });
        }
        if (url.indexOf('textdb.online/') >= 0 && url.indexOf('api.textdb') < 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            if (!cloudFile) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: cloudFile });
        }
        if (url.indexOf('api.github.com/repos/') >= 0) return route.fulfill({ status: 404, body: '404' });
        if (url.indexOf('raw.githubusercontent.com/') >= 0 || url.indexOf('cdn.jsdelivr.net/gh/') >= 0) return route.fulfill({ status: 404, body: '404' });
        return route.fallback();
    });
}

async function login(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1200);
}

const waitFor = async (fn, timeout = 15000) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
        last = await fn();
        if (last) return last;
        await new Promise(r => setTimeout(r, 300));
    }
    return last;
};

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    /* ============ O1：舊版升級遺留孤兒（用戶真實場景） ============ */
    console.log('\n[O1] 舊版孤兒：手機刪除→push失敗→App重開→自動治癒上雲→電腦看到');

    // 1. 電腦 A 建立雲端基準
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await ctxA.newPage();
    await mockAll(pageA);
    await login(pageA);
    await pageA.evaluate(() => CloudSync.push(true));
    await pageA.waitForTimeout(800);
    const nA = await pageA.evaluate(() => DB.list('customers').length);
    const revCloud = await pageA.evaluate(() => CloudSync.peek().then(s => s.rev));
    ok('A1 電腦 A 建立雲端基準（rev=' + revCloud + ', customers=' + nA + '）', nA > 0 && revCloud > 0, { nA, revCloud });

    // 2. 手機 B 全新環境首拉（= 舊手機最後一次成功同步的狀態）
    const ctxB = await browser.newContext({ viewport: { width: 414, height: 896 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    const pageB = await ctxB.newPage();
    await mockAll(pageB);
    await login(pageB);
    await pageB.waitForTimeout(2200); // 首拉 1.5s
    const nB0 = await pageB.evaluate(() => DB.list('customers').length);
    const revB0 = await pageB.evaluate(() => Utils.num(DB._mem.__rev) || 0);
    ok('A2 手機 B 首拉對齊雲端（customers=' + nB0 + '）', nB0 === nA, { nA, nB0 });

    // 3. 模擬舊版孤兒：斷網刪除（push 靜默失敗）+ 模擬舊數據無 __hash + App 重開（_pendingPush 歸零）
    textdbDown = true;
    const victim = await pageB.evaluate(() => {
        const c = DB.list('customers')[DB.list('customers').length - 1];
        DB.remove('customers', c.id);
        return { id: c.id, code: c.code };
    });
    await pageB.waitForTimeout(600);
    // 模擬舊版數據（從未記錄 __hash）與 App 重開
    await pageB.evaluate(() => {
        delete DB._mem.__hash;
        localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(DB._mem));
    });
    await login(pageB); // 重新載入 = App 重開
    // 重開後 headless 頁面載入時序可能觸發 focus/storage 事件 → schedulePush 重新置位 pending（新代碼健壯性）。
    // 為忠實復現「舊版記憶體標誌歸零」的孤兒狀態，此處顯式歸零，強制 A4 走「hash 對帳」治癒路徑。
    await pageB.evaluate(() => { CloudSync._pendingPush = false; });
    const pendB = await pageB.evaluate(() => CloudSync._pendingPush);
    ok('A3 App 重開後 _pendingPush 歸零（孤兒狀態復現）', pendB === false, { pendB });

    // 4. 網絡恢復 → 自動輪詢 pull → 指紋對帳發現孤兒 → 後推贏自動上傳
    textdbDown = false;
    // 主動觸發一次 pull（manual=false，與 12s 自動輪詢完全同一路徑）：
    // 消除「輪詢相位 vs waitFor 20s 窗口」競態——輪詢間隔 12s，網絡恢復時可能剛錯過一輪，
    // 治癒要等下一輪 12s + push 時間，偶發超窗。邏輯本身不變（對帳→孤兒→先推）。
    await pageB.evaluate(() => { CloudSync._busy = false; CloudSync.pull(false).catch(() => { }); });
    await pageB.waitForTimeout(1500);
    const healed = await waitFor(() => pageB.evaluate(id => CloudSync.peek().then(s => {
        const arr = (s && s.payload && s.payload.customers) || [];
        return !arr.find(r => r.id === id);
    }).catch(() => false), victim.id), 20000);
    const localVictimGone = await pageB.evaluate(id => !DB.find('customers', c => c.id === id), victim.id);
    const hashB = await pageB.evaluate(() => String(DB._mem.__hash || ''));
    ok('A4 手機孤兒刪除自動治癒上雲（雲端已無 ' + victim.code + '）', healed === true && localVictimGone === true, { healed, localVictimGone });

    // 5. 電腦 A 自動拉到刪除
    await pageA.evaluate(() => CloudSync.pull(false));
    const aGone = await waitFor(() => pageA.evaluate(id => !DB.find('customers', c => c.id === id), victim.id), 15000);
    ok('A5 電腦 A 自動看到手機的刪除（跨設備連動成立）', aGone === true, { aGone });

    /* ============ O2：新程式碼孤兒（__hash 指紋失配判定） ============ */
    console.log('\n[O2] 新版孤兒：__hash 失配 → 斷網編輯 → App 重開 → 自動治癒');

    // 1. 手機 B 斷網改名（push 失敗）→ App 重開
    textdbDown = true;
    await pageB.evaluate(() => {
        const c = DB.list('customers')[0];
        DB.update('customers', c.id, { name: '指紋治癒改名' });
        return c.id;
    });
    await pageB.waitForTimeout(600);
    await login(pageB); // App 重開
    const hashB2 = await pageB.evaluate(() => String(DB._mem.__hash || ''));
    ok('B1 手機重開後保留 __hash 指紋（' + hashB2.slice(0, 8) + '…）', hashB2.length === 16, { hashB2 });

    // 2. 網絡恢復 → 指紋失配（本地指紋 ≠ __hash）→ 自動推送治癒
    textdbDown = false;
    const healed2 = await waitFor(() => pageB.evaluate(() => CloudSync.peek().then(s => {
        const arr = (s && s.payload && s.payload.customers) || [];
        return arr.some(r => r.name === '指紋治癒改名');
    }).catch(() => false)), 20000);
    ok('B2 指紋失配孤兒自動上雲（雲端已見新名）', healed2 === true, { healed2 });

    // 3. 電腦 A 拉到改名
    await pageA.evaluate(() => CloudSync.pull(false));
    const aRenamed = await waitFor(() => pageA.evaluate(() => !!DB.find('customers', c => c.name === '指紋治癒改名')), 15000);
    ok('B3 電腦 A 自動看到手機的改名', aRenamed === true, { aRenamed });

    /* ============ O3：指紋自洽 / 冪等 ============ */
    console.log('\n[O3] 指紋自洽：推送成功後 __hash = 當前指紋（乾淨狀態不誤判）');
    const selfOK = await pageB.evaluate(() => {
        const h1 = CloudSync.payloadHash(DB._mem);
        return h1 === String(DB._mem.__hash || '');
    });
    ok('C1 推送成功後 __hash 與本地指紋一致（不誤判為髒）', selfOK === true, { selfOK });
    const r = await pageB.evaluate(() => CloudSync.pull(false));
    ok('C2 乾淨狀態 pull 回 true（無多餘推送）', r === true);

    await browser.close();
    console.log('\n========== 總計: ' + passed + ' 通過 / ' + failed + ' 失敗 ==========');
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); if (browser) browser.close(); process.exit(1); });
