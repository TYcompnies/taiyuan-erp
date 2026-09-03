/**
 * test-purge-purchase.js — 清除采购资料迁移专项测试（2026-09-03，dbVersion 2→3）
 * 需求：清除日常作业的采购单与采购退回/折让资料。
 * 实现：purgePurchasing()（DB.load / sync.applyRemote 套用远端后都会执行，幂等）——
 *        清空 purchase_orders / purchase_returns，并回冲采购环节造成的库存净变动
 *        （已进货 received 的加量扣回、退回的扣减复原），保留商品等其余资料；
 *        同时摘除已删除的「日常流程」权限 workflow.view。
 * 验证：干净种子状态 / 旧快照(2→3)迁移清除+库存回冲 / 折让只清数据不动库存 /
 *       商品保留 / 角色 workflow.view 摘除 / 幂等。
 * 运行：BASE=<云端或本地 URL> node test-purge-purchase.js
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
    // 拦截云同步域名（textdb/GitHub），防 reload 后 startAuto 拉生产云覆盖注入的旧快照/登出
    await page.context().route(/textdb\.online|github|githubusercontent/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);
    // 彻底断开云同步（防种子/测试数据推送生产云、防云端覆盖注入的旧快照）
    await page.evaluate(() => {
        try {
            localStorage.removeItem("taiyuan_sync_cfg_v1");
            if (typeof CloudSync !== "undefined") {
                CloudSync.DEFAULT_SYNC_CFG = null;
                CloudSync._started = true;
                if (CloudSync._pullTimer) clearInterval(CloudSync._pullTimer);
            }
        } catch (e) { }
    });
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

        /* ---------- 1. 干净种子状态（dbVersion 3） ---------- */
        await test('T1 干净种子：无采购单/采购退回、dbVersion=3、无 workflow.view', async () => {
            const v = await page.evaluate(() => ({
                po: (DB.list('purchase_orders') || []).length,
                pr: (DB.list('purchase_returns') || []).length,
                ver: DB._mem.dbVersion,
                wf: (DB._mem.roles || []).some(r => (r.permissions || []).includes('workflow.view'))
            }));
            if (v.po !== 0 || v.pr !== 0) throw new Error('种子不应含采购资料: ' + JSON.stringify(v));
            if (v.ver !== 3) throw new Error('种子 dbVersion=' + v.ver + '（期望 3）');
            if (v.wf) throw new Error('仍有角色持有 workflow.view');
        });

        /* ---------- 2. 旧快照 dbVersion 2 → 3 迁移 ---------- */
        await test('T2 旧版采购资料迁移清除（dbVersion 2→3）', async () => {
            await page.evaluate(() => {
                const m = JSON.parse(localStorage.getItem('taiyuan_erp_data_v1'));
                m.dbVersion = 2;
                // 两个测试商品（purchase_to_stock=1 简化回冲口径）
                m.items.push({ id: 'pgiA', code: 'PG-A', name: '清采测试A', unit: '个', purchase_to_stock: 1 });
                m.items.push({ id: 'pgiB', code: 'PG-B', name: '清采测试B', unit: '个', purchase_to_stock: 1 });
                // 库存现状：pgiA 含进货 100（进货后存量 150）；pgiB 被退 30（退回后存量 20）
                m.stock = { wh1: { pgiA: 150, pgiB: 20 } };
                // 旧版采购单：received 已进货
                m.purchase_orders = [{
                    id: 'po_pg1', no: 'PO20260101001', status: 'received', warehouse_id: 'wh1',
                    lines: [{ item_id: 'pgiA', qty: 100, name: '清采测试A' }]
                }];
                // 旧版采购退回/折让：退回 30（动库存）、折让（仅金额不动库存）
                m.purchase_returns = [
                    { id: 'pr_pg1', no: 'PR20260102001', type: '退回', warehouse_id: 'wh1', lines: [{ item_id: 'pgiB', qty: 30, name: '清采测试B' }] },
                    { id: 'pr_pg2', no: 'PR20260102002', type: '折让', lines: [{ item_id: 'pgiA', qty: 0, amount: 50 }] }
                ];
                // 旧角色残留：r3 业务持有已删除的 workflow.view
                const r3 = m.roles.find(r => r.id === 'r3');
                if (r3) r3.permissions.push('workflow.view');
                localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(m));
            });
            await page.reload();
            await page.waitForTimeout(1500);
            const v = await page.evaluate(() => ({
                po: (DB.list('purchase_orders') || []).length,
                pr: (DB.list('purchase_returns') || []).length,
                ver: DB._mem.dbVersion,
                stA: ((DB._mem.stock || {}).wh1 || {}).pgiA,
                stB: ((DB._mem.stock || {}).wh1 || {}).pgiB,
                wf: (DB._mem.roles || []).some(r => (r.permissions || []).includes('workflow.view')),
                items: DB.list('items').filter(i => i.id === 'pgiA' || i.id === 'pgiB').length
            }));
            if (v.po !== 0 || v.pr !== 0) throw new Error('采购资料未清空: ' + JSON.stringify(v));
            if (v.ver !== 3) throw new Error('dbVersion 未升至 3: ' + v.ver);
            if (v.stA !== 50) throw new Error('库存回冲错误 pgiA=' + v.stA + '（期望 50 = 150-100 扣回进货）');
            if (v.stB !== 50) throw new Error('库存回冲错误 pgiB=' + v.stB + '（期望 50 = 20+30 复原退回）');
            if (v.wf) throw new Error('workflow.view 未摘除');
            if (v.items !== 2) throw new Error('商品资料被误删: ' + v.items);
        });

        /* ---------- 3. 幂等（重复加载不再产生改动） ---------- */
        await test('T3 迁移幂等（重复 reload 快照字符串不变）', async () => {
            const before = await page.evaluate(() => localStorage.getItem('taiyuan_erp_data_v1'));
            await page.reload();
            await page.waitForTimeout(1200);
            const after = await page.evaluate(() => localStorage.getItem('taiyuan_erp_data_v1'));
            if (before !== after) throw new Error('重复加载仍改动数据（幂等失败）');
        });

        /* ---------- 4. 结算口径不受影响（应收应付 / 库存总览仍可用） ---------- */
        await test('T4 清除后 AR/AP 页仍正常渲染', async () => {
            await page.evaluate(() => { location.hash = '#/accounting/accounts-receivable'; });
            await page.waitForTimeout(600);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('进销存应收账款') < 0) throw new Error('AR 页未渲染');
        });
        await test('T5 清除后库存总览页仍正常渲染', async () => {
            await page.evaluate(() => { location.hash = '#/inventory/inventory_overview'; });
            await page.waitForTimeout(600);
            const t = await page.evaluate(() => document.body.textContent);
            if (t.indexOf('进销存库存总览') < 0) throw new Error('库存总览页未渲染');
        });

        /* ---------- 5. 菜单与权限界面一致 ---------- */
        await test('T6 菜单不再含「日常流程」、权限清单无 workflow.view', async () => {
            const v = await page.evaluate(() => ({
                menuHas: Array.from(document.querySelectorAll('.sidebar a')).some(a => a.textContent.indexOf('日常流程') >= 0),
                permHas: Array.from(document.querySelectorAll('*')).some(el => el.textContent.trim() === '查看日常流程')
            }));
            if (v.menuHas) throw new Error('侧边栏仍含日常流程');
            if (v.permHas) throw new Error('权限列表仍含 workflow.view 标签');
        });
    } catch (e) {
        fail++;
        results.push(`❌ FAIL: 脚本异常 — ${e.message.split('\n')[0]}`);
    } finally {
        await browser.close();
    }
    console.log(results.join('\n'));
    console.log(`\n== 采购清除迁移测试: ${pass} 通过, ${fail} 失败 ==`);
    process.exit(fail ? 1 : 0);
})();
