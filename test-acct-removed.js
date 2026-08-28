/**
 * test-acct-removed.js — 会计模块移除专项测试（2026-08-28）
 * 验证：菜单/路由/页面移除、数据清空迁移（purgeAccounting）、AR/AP 保留可用、
 *       角色权限清理、Dashboard 不再引用传票/损益表/费用。
 * （取代原 test-accounting.js —— 会计模块已整体移除）
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8904';

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
    try { await fn(); pass++; results.push(`✅ PASS: ${name}`); }
    catch (e) { fail++; results.push(`❌ FAIL: ${name} — ${e.message.split('\n')[0]}`); }
}
async function login(page) {
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar, nav', { timeout: 15000 });
    await page.waitForTimeout(500);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    try {
        await login(page);

        /* ---------- 1. 模块代码不再加载 ---------- */
        await test('R1 会计模块脚本已移除（ACCT 未定义）', async () => {
            const v = await page.evaluate(() => typeof ACCT);
            if (v !== 'undefined') throw new Error('ACCT 仍存在: ' + v);
        });
        await test('R2 会计页面函数已移除（Pages.chartAccounts/incomeStatement 未定义）', async () => {
            const v = await page.evaluate(() => ({
                ca: typeof Pages.chartAccounts, is: typeof Pages.incomeStatement,
                gl: typeof Pages.generalLedger, tb: typeof Pages.trialBalance,
                bs: typeof Pages.balanceSheet, ex: typeof Pages.expenses, vo: typeof Pages.vouchers
            }));
            for (const k of Object.keys(v)) if (v[k] !== 'undefined') throw new Error(k + ' 仍存在: ' + v[k]);
        });

        /* ---------- 2. 菜单清理 ---------- */
        await test('R3 菜单不再包含会计/费用/传票/损益入口', async () => {
            const labels = await page.evaluate(() => {
                const arr = [];
                document.querySelectorAll('.menu-link, .menu a').forEach(a => arr.push(a.textContent.trim()));
                return arr;
            });
            const gone = ['传票作业', '会计科目', '总分类账', '试算表', '资产负债表', '损益表', '费用支出'];
            const hit = labels.filter(l => gone.includes(l));
            if (hit.length) throw new Error('菜单仍包含: ' + hit.join(','));
        });
        await test('R4 菜单保留应收账款/应付账款', async () => {
            const labels = await page.evaluate(() => {
                const arr = [];
                document.querySelectorAll('.menu-link, .menu a').forEach(a => arr.push(a.textContent.trim()));
                return arr;
            });
            if (!labels.includes('应收账款')) throw new Error('缺少 应收账款');
            if (!labels.includes('应付账款')) throw new Error('缺少 应付账款');
        });

        /* ---------- 3. 路由移除（回首页） ---------- */
        for (const hash of ['#/accounting/vouchers', '#/accounting/accounts', '#/accounting/general-ledger',
            '#/accounting/trial-balance', '#/accounting/balance-sheet', '#/accounting/income-statement', '#/expenses']) {
            await test('R5 路由 ' + hash + ' 已移除（回到首页）', async () => {
                await page.goto(BASE + '/?' + hash.slice(2) + hash); // 保持会话
                await page.evaluate(h => { location.hash = h; }, hash);
                await page.waitForTimeout(600);
                const ok = await page.evaluate(() => location.hash === '#/dashboard' || document.body.textContent.indexOf('找不到该页面') >= 0);
                if (!ok) throw new Error('当前 hash=' + location.hash);
            });
        }

        /* ---------- 4. AR/AP 保留可用 ---------- */
        await test('R6 应收账款页正常渲染（收款登记入口）', async () => {
            await page.evaluate(() => { location.hash = '#/accounting/accounts-receivable'; });
            await page.waitForTimeout(600);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('应收账款') < 0) throw new Error('页面未渲染应收账款');
            const fn = await page.evaluate(() => typeof Pages.receivePayment);
            if (fn !== 'function') throw new Error('receivePayment 函数缺失: ' + fn);
        });
        await test('R7 应付账款页正常渲染（付款登记入口）', async () => {
            await page.evaluate(() => { location.hash = '#/accounting/accounts-payable'; });
            await page.waitForTimeout(600);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('应付账款') < 0) throw new Error('页面未渲染应付账款');
            const fn = await page.evaluate(() => typeof Pages.payPO);
            if (fn !== 'function') throw new Error('payPO 函数缺失: ' + fn);
        });

        /* ---------- 5. 数据清空迁移（purgeAccounting） ---------- */
        await test('R8 旧会计数据被清空迁移（vouchers/chart_accounts/expenses → 空）', async () => {
            await page.evaluate(() => {
                // 模拟旧版设备：注入含会计数据的旧快照
                const m = JSON.parse(localStorage.getItem('taiyuan_erp_data_v1'));
                m.chart_accounts = [{ id: 'a1001', code: '1001', name: '库存现金', type: '资产', direction: '借', is_cash: true }];
                m.vouchers = [{ id: 'v1', no: 'V001', status: '未过账', lines: [{ debit: 100 }, { credit: 100 }] }];
                m.expenses = [{ id: 'e1', no: 'EXP001', date: '2026-08-01', amount: 500 }];
                localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(m));
            });
            await page.reload();
            await page.waitForTimeout(1500);
            const v = await page.evaluate(() => ({
                ca: (DB.list('chart_accounts') || []).length,
                vo: (DB.list('vouchers') || []).length,
                ex: (DB.list('expenses') || []).length
            }));
            if (v.ca || v.vo || v.ex) throw new Error('未清空: ' + JSON.stringify(v));
        });
        await test('R9 purge 幂等（重复 reload 不再产生改动）', async () => {
            const before = await page.evaluate(() => localStorage.getItem('taiyuan_erp_data_v1'));
            await page.reload();
            await page.waitForTimeout(1200);
            const after = await page.evaluate(() => localStorage.getItem('taiyuan_erp_data_v1'));
            if (before !== after) throw new Error('重复加载仍改动数据（幂等失败）');
        });

        /* ---------- 6. 角色权限清理 ---------- */
        await test('R10 所有角色不再持有会计权限', async () => {
            const gone = await page.evaluate(() => {
                const bad = [];
                const GONE = ['finance.account', 'finance.ledger', 'finance.balance', 'finance.voucher', 'finance.income', 'finance.expense'];
                (DB._mem.roles || []).forEach(r => (r.permissions || []).forEach(pc => { if (GONE.indexOf(pc) >= 0) bad.push(r.id + ':' + pc); }));
                return bad;
            });
            if (gone.length) throw new Error('残留权限: ' + gone.join(','));
        });
        await test('R11 会计角色保留 AR/AP（可登录收付款）', async () => {
            const r5 = await page.evaluate(() => (DB._mem.roles || []).find(r => r.id === 'r5'));
            if (!r5) throw new Error('r5 角色缺失');
            if ((r5.permissions || []).indexOf('finance.ar') < 0) throw new Error('r5 缺 finance.ar');
            if ((r5.permissions || []).indexOf('finance.ap') < 0) throw new Error('r5 缺 finance.ap');
        });

        /* ---------- 7. Dashboard 清理 ---------- */
        await test('R12 仪表板无「待切传票」KPI、无「损益表」链接', async () => {
            await page.evaluate(() => { location.hash = '#/dashboard'; });
            await page.waitForTimeout(800);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('待切传票') >= 0) throw new Error('仍有待切传票 KPI');
            if (t.indexOf('损益表') >= 0) throw new Error('仍有损益表链接/文案');
            if (t.indexOf('费用支出') >= 0) throw new Error('仍有费用支出入口');
            if (t.indexOf('本月毛利') < 0) throw new Error('缺少本月毛利 KPI');
        });
        await test('R13 日常流程页无费用/传票/损益卡片', async () => {
            await page.evaluate(() => { location.hash = '#/daily-workflow'; });
            await page.waitForTimeout(600);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('费用支出') >= 0 || t.indexOf('传票作业') >= 0 || t.indexOf('损益表') >= 0) throw new Error('日常流程仍含会计卡片');
        });

        /* ---------- 8. 业务流程不受影响（出货不再联动传票但库存正常） ---------- */
        await test('R14 业务函数正常（出货/收退款 API 存在且无 ACCT 依赖）', async () => {
            const v = await page.evaluate(() => {
                const s = (window.__saveLock === undefined);
                return { doShip: typeof Pages.doShip, receivePO: typeof Pages.receivePO, saveLockClean: s };
            });
            if (v.doShip !== 'function') throw new Error('doShip 缺失');
            if (v.receivePO !== 'function') throw new Error('receivePO 缺失');
        });

    } catch (e) {
        console.error('FATAL:', e.message);
    } finally {
        await browser.close();
    }

    console.log(results.join('\n'));
    console.log(`\n总计: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})();
