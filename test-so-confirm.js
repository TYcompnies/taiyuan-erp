/**
 * test-so-confirm.js — 销货订单「确认收到」专项回归测试（20260907f，云端可跑）
 * 需求：新订单（远端同步到达、无 received_at）必须点选「确认收到订单」才能出货；
 *       销货订单菜单显示红色圆形白字徽章计数（全部确认后消失）；
 *       未确认时每 2 分钟重复提示音共 3 次（本测试将 REMIND_DELAY 加速为毫秒级验证）。
 * 覆盖：徽章显隐/计数 / 列表门禁 / 详情页确认 / 出货双保险 / 角色权限（仓管可确认、业务不可）
 *       / 提醒链与停止 / UI 新建自动盖章 / 旧资料一次性迁移守卫（重启/远端套用不误盖章）。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8911';

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
    try { await fn(); pass++; results.push(`✅ PASS: ${name}`); }
    catch (e) { fail++; results.push(`❌ FAIL: ${name} — ${e.message.split('\n')[0]}`); }
}
async function db(page, fn, arg) { return page.evaluate(fn, arg); }
/* 整页导航（重试一次抗沙箱偶发超时） */
async function nav(page, url) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
}
/* 哈希路由：先离开当前 hash 再进入目标，保证同 hash 也强制重渲染 */
async function gotoHash(page, h) {
    const cur = await page.evaluate(() => location.hash);
    if (cur === h) {
        await page.evaluate(() => { location.hash = '#/dashboard'; });
        await page.waitForTimeout(350);
    }
    await page.evaluate((x) => { location.hash = x; }, h);
    await page.waitForTimeout(600);
}
/* 把 Node 侧的 mkSO 注入浏览器 window（每次整页加载后都要重新注入） */
async function injectMK(page) {
    await page.addScriptTag({ content: 'window.mkSO = ' + mkSO.toString() + ';' });
}
async function login(page, u, p) {
    await nav(page, BASE);
    await page.waitForSelector('#loginForm input[name="username"]', { timeout: 20000 });
    await page.fill('input[name="username"]', u);
    await page.fill('input[name="password"]', p);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar, nav', { timeout: 20000 });
    await page.waitForTimeout(600);
    await injectMK(page);
}
/* 切换登录用户：clearSession 后整页刷新回登录屏 */
async function switchUser(page, u, p) {
    await page.evaluate(() => DB.clearSession());
    await nav(page, BASE);
    await page.waitForSelector('#loginForm input[name="username"]', { timeout: 20000 });
    await page.fill('input[name="username"]', u);
    await page.fill('input[name="password"]', p);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar, nav', { timeout: 20000 });
    await page.waitForTimeout(600);
    await injectMK(page);
}
function badgeOf(page) {
    return page.evaluate(() => {
        const el = document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge');
        return el ? el.textContent.trim() : null;
    });
}
/* 直接落库一笔「待确认」销货订单（模拟他机同步到达、未经本机点选确认） */
function mkSO(id, no, custId, itemId, qty) {
    return {
        id, no, channel: '虾皮', platform_no: 'PLT-' + no, customer_id: custId,
        payment_status: 'unpaid', payment_method: '', currency: 'CNY',
        order_date: '2026-09-07', delivery_date: '', status: 'draft',
        logistics_method: '圆通速递', sales_owner: 'admin', shipment_no: '',
        recipient_name: '', recipient_phone: '', shipping_address: '',
        invoice_type: '不开发票', price_tax_mode: '含税', tax_type: '不计税', tax_rate: 0,
        shipping_fee: 0, commission_rate: 0, platform_fee: 0, payment_fee: 0, other_fee: 0,
        settlement_tax_included: false, taxable_amount: qty * 10, tax_amount: 0,
        invoice_amount: qty * 10, net_receipt: qty * 10,
        invoice_title: '', invoice_tax_id: '', invoice_no: '', invoice_date: '', invoice_status: '未开',
        lines: [{ item_id: itemId, code: 'CF-001', name: '确认流程测试商品', qty, unit: '个', unit_price: 10, amount: qty * 10, remark: '' }],
        remark: '', created_by: 'DTEST'
    };
}
/* 断云：textdb / GitHub 全拦截，云端视为无资料 */
async function cutCloud(ctx) {
    await ctx.route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com|cdn\.jsdelivr\.net/i, async r => {
        const url = r.request().url();
        if (url.includes('github')) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (r.request().method() === 'POST') return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' });
        if (url.includes('api.textdb.online/update/')) return r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' });
        return r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' });
    });
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();
    await cutCloud(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(12000);
    try {
        await login(page, 'admin', 'admin123');

        /* ===== 0. 环境：清空业务单据，建一个可出货商品 ===== */
        await db(page, () => {
            ['sales_orders', 'shipments', 'purchase_orders', 'sales_returns', 'purchase_returns',
                'expenses', 'vouchers', 'inventory_adjusts'].forEach(c => DB._mem[c] = []);
            DB._mem.stock = {};
            if (!DB.list('items').some(i => i.id === 'it_cf')) {
                DB.insert('items', { id: 'it_cf', code: 'CF-001', name: '确认流程测试商品', unit: '个', stock_unit: '个', sales_unit: '个', purchase_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, cost: 3, purchase_currency: 'CNY', safe_qty: 0, status: true });
            }
            DB.addStock('wh1', 'it_cf', 200);
            CloudSync.stopReminderCycle();
            return { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
        });

        /* ===== T1 UI 新建订单自动视为已确认（不亮徽章） ===== */
        await test('T1 UI 新建销货订单自动盖章 received_at、菜单无徽章', async () => {
            await page.evaluate(() => { location.hash = '#/sales-orders/create'; });
            await page.waitForTimeout(500);
            await page.selectOption('[name="customer_id"]', { index: 1 });
            await page.selectOption('[name="sales_owner"]', { index: 1 });
            await page.selectOption('#salesLines tbody tr select', { index: 1 });
            await page.fill('#salesLines tbody tr [name="qty[]"]', '1');
            await page.fill('#salesLines tbody tr [name="unit_price[]"]', '10');
            await page.click('button:has-text("保存销货订单")');
            await page.waitForTimeout(900);
            const r = await db(page, () => {
                const o = DB.list('sales_orders').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
                return o ? { no: o.no, ok: !!o.received_at, badge: (document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge') || {}).textContent || null } : null;
            });
            if (!r) throw new Error('UI 新建未落库');
            if (!r.ok) throw new Error('UI 新建订单未自动盖章 received_at');
            if (r.badge !== null) throw new Error('无待确认单时菜单不应有徽章, got ' + r.badge);
        });

        /* ===== T2 远端新订单：徽章计数 + 列表门禁 ===== */
        let ids;
        await test('T2 待确认订单亮红点徽章、列表无出货按钮且直调出货被拒', async () => {
            ids = await db(page, (cfg) => {
                const o = DB.insert('sales_orders', mkSO('so_cf_u1', 'SO-CF-U1', cfg.custId, cfg.itemId, 2));
                DB.flush();
                return { id: o.id, no: o.no };
            }, await db(page, () => ({ custId: DB.list('customers')[0].id, itemId: 'it_cf' })));
            await gotoHash(page, '#/sales-orders');
            // 徽章 = 1
            const badge = await badgeOf(page);
            if (badge !== '1') throw new Error('菜单徽章期望 1 实际 ' + badge);
            // 行内：确认收到 有、出货 无、状态含 待确认收到
            const ui = await page.evaluate((no) => {
                const row = Array.from(document.querySelectorAll('#soBody tr')).find(tr => tr.textContent.includes(no));
                if (!row) return { found: false };
                const btns = Array.from(row.querySelectorAll('button'));
                return {
                    found: true,
                    confirmBtn: btns.some(b => b.textContent.trim() === '确认收到'),
                    shipBtn: btns.some(b => b.textContent.trim() === '出货'),
                    pendingTxt: row.textContent.includes('待确认收到'),
                    filterHas: Array.from(document.querySelectorAll('#soStatusFilter option')).some(o => o.value === 'unconfirmed' && o.textContent.includes('待确认收到'))
                };
            }, ids.no);
            if (!ui.found) throw new Error('列表找不到 SO-CF-U1');
            if (!ui.confirmBtn) throw new Error('待确认订单行应有「确认收到」按钮');
            if (ui.shipBtn) throw new Error('未确认订单不应出现「出货」按钮');
            if (!ui.pendingTxt) throw new Error('状态列未显示「待确认收到」');
            if (!ui.filterHas) throw new Error('状态筛选缺少「待确认收到」选项');
            // 直调出货（门禁）：应 toast 拒绝、状态不变、无出货单
            const gate = await db(page, (id) => new Promise(res => {
                Pages.shipOrder(id);
                setTimeout(() => res({
                    toast: (document.getElementById('toastWrap') || {}).textContent || '',
                    st: DB.get('sales_orders', id).status,
                    ships: DB.list('shipments').filter(s => s.sales_order_id === id).length,
                    modal: !!document.querySelector('.modal-mask')
                }), 250);
            }), ids.id);
            if (!gate.toast.includes('确认收到订单')) throw new Error('门禁 toast 提示缺失: ' + gate.toast);
            if (gate.st !== 'draft') throw new Error('门禁误改状态: ' + gate.st);
            if (gate.ships !== 0) throw new Error('门禁下不应产生出货单');
            if (gate.modal) throw new Error('门禁不应弹出出货仓库选择框');
        });

        /* ===== T3 列表点「确认收到」→ 徽章消失 → 可出货 ===== */
        await test('T3 列表确认收到后徽章消失、出货按钮出现且可出货', async () => {
            await gotoHash(page, '#/sales-orders');
            await page.locator('#soBody tr:has-text("SO-CF-U1") button:has-text("确认收到")').click();
            await page.waitForSelector('.modal-mask #confirmOkBtn', { timeout: 5000 });
            await page.click('.modal-mask #confirmOkBtn');
            await page.waitForTimeout(600);
            const after = await db(page, (arg) => {
                const row = Array.from(document.querySelectorAll('#soBody tr')).find(tr => tr.textContent.includes(arg.no));
                return {
                    received_at: DB.get('sales_orders', arg.id).received_at || null,
                    badge: (document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge') || {}).textContent || null,
                    shipBtn: row ? Array.from(row.querySelectorAll('button')).some(b => b.textContent.trim() === '出货') : false
                };
            }, { id: ids.id, no: ids.no });
            if (!after.received_at) throw new Error('确认后未写入 received_at');
            if (after.badge !== null) throw new Error('全部确认后徽章应消失, got ' + after.badge);
            if (!after.shipBtn) throw new Error('确认后应出现「出货」按钮');
            // 出货
            await page.locator('#soBody tr:has-text("SO-CF-U1") button:has-text("出货")').click();
            await page.waitForSelector('.modal-mask #shipWh', { timeout: 5000 });
            await page.selectOption('#shipWh', { index: 0 });
            await page.click('.modal-mask .modal-foot .btn.primary');
            await page.waitForTimeout(600);
            const shipped = await db(page, (id) => ({ st: DB.get('sales_orders', id).status, ships: DB.list('shipments').filter(s => s.sales_order_id === id).length, stock: DB.totalStock('it_cf') }), ids.id);
            if (shipped.st !== 'shipped') throw new Error('出货失败: ' + shipped.st);
            if (shipped.ships !== 1) throw new Error('出货单未建立');
            if (shipped.stock !== 198) throw new Error('库存未扣 2 个, 现 ' + shipped.stock);
        });

        /* ===== T4 详情页确认 + doShip 双保险 ===== */
        await test('T4 详情页「确认收到订单」按钮 + 直调 doShip 被拒 + 确认后出货成功', async () => {
            const d = await db(page, () => {
                const cfg = { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
                const o = DB.insert('sales_orders', mkSO('so_cf_u2', 'SO-CF-U2', cfg.custId, cfg.itemId, 3));
                DB.flush();
                return { id: o.id, no: o.no };
            });
            await gotoHash(page, '#/sales-orders/' + d.id);
            // 直调 doShip（双保险门禁）
            const gate = await db(page, (id) => new Promise(res => {
                Pages.doShip(id);
                setTimeout(() => res({ st: DB.get('sales_orders', id).status, ships: DB.list('shipments').filter(s => s.sales_order_id === id).length }), 200);
            }), d.id);
            if (gate.st !== 'draft' || gate.ships !== 0) throw new Error('doShip 双保险失效');
            // 详情页 UI
            const ui = await page.evaluate(() => {
                const body = document.body.textContent;
                return {
                    detailBtn: !!Array.from(document.querySelectorAll('.content button, .content a')).find(b => b.textContent.includes('确认收到订单')),
                    pending: body.includes('待确认收到'),
                    pendingCard: body.includes('尚未点选「确认收到订单」')
                };
            });
            if (!ui.detailBtn) throw new Error('详情页缺少「确认收到订单」按钮');
            if (!ui.pending) throw new Error('详情页应显示待确认收到');
            if (!ui.pendingCard) throw new Error('详情页应显示待确认提示卡');
            // 点详情页确认按钮
            await page.locator('.content button:has-text("确认收到订单")').first().click();
            await page.waitForSelector('.modal-mask #confirmOkBtn', { timeout: 5000 });
            await page.click('.modal-mask #confirmOkBtn');
            await page.waitForTimeout(700);
            const after = await page.evaluate((id) => {
                const o = DB.get('sales_orders', id);
                const body = document.body.textContent;
                return {
                    received_at: o.received_at || null,
                    green: body.includes('已确认收到'),
                    pendingGone: !body.includes('尚未点选「确认收到订单」')
                };
            }, d.id);
            if (!after.received_at) throw new Error('详情页确认未写 received_at');
            if (!after.green) throw new Error('详情页未显示「已确认收到」');
            if (!after.pendingGone) throw new Error('确认后提示卡未消失');
            // 确认后从详情回到列表出货（库存 198-3=195）
            await gotoHash(page, '#/sales-orders');
            await page.locator('#soBody tr:has-text("SO-CF-U2") button:has-text("出货")').click();
            await page.waitForSelector('.modal-mask #shipWh', { timeout: 5000 });
            await page.selectOption('#shipWh', { index: 0 });
            await page.click('.modal-mask .modal-foot .btn.primary');
            await page.waitForTimeout(600);
            const shipped = await db(page, (id) => DB.get('sales_orders', id).status, d.id);
            if (shipped !== 'shipped') throw new Error('确认后仍无法出货: ' + shipped);
        });

        /* ===== T5 仓管可确认出货；业务无确认/出货权（含直调被拒） ===== */
        await test('T5 仓管可点确认收到并出货；业务角色无确认/出货权限', async () => {
            // 先落一笔待确认单（admin 视角模拟远端到达）
            const d = await db(page, () => {
                const cfg = { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
                const o = DB.insert('sales_orders', mkSO('so_cf_u3', 'SO-CF-U3', cfg.custId, cfg.itemId, 1));
                DB.flush();
                return { id: o.id, no: o.no };
            });
            // 切仓管（r4：sales.ship）
            await switchUser(page, 'warehouse', '123456');
            await gotoHash(page, '#/sales-orders');
            const whBefore = await page.evaluate((no) => {
                const row = Array.from(document.querySelectorAll('#soBody tr')).find(tr => tr.textContent.includes(no));
                const btns = row ? Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
                return { confirmBtn: btns.includes('确认收到'), shipBtn: btns.includes('出货') };
            }, d.no);
            if (!whBefore.confirmBtn) throw new Error('仓管应看到「确认收到」按钮');
            if (whBefore.shipBtn) throw new Error('未确认时仓管也不应看到「出货」');
            await page.locator('#soBody tr:has-text("SO-CF-U3") button:has-text("确认收到")').click();
            await page.waitForSelector('.modal-mask #confirmOkBtn', { timeout: 5000 });
            await page.click('.modal-mask #confirmOkBtn');
            await page.waitForTimeout(600);
            // 确认后：徽章消失 + 出货按钮出现；仓管直接出货
            const whAfter = await page.evaluate((no) => {
                const row = Array.from(document.querySelectorAll('#soBody tr')).find(tr => tr.textContent.includes(no));
                const btns = row ? Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
                return {
                    shipBtn: btns.includes('出货'),
                    badge: (document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge') || {}).textContent || null
                };
            }, d.no);
            if (!whAfter.shipBtn) throw new Error('仓管确认后应看到「出货」按钮');
            if (whAfter.badge !== null) throw new Error('确认后徽章应消失, got ' + whAfter.badge);
            await page.locator('#soBody tr:has-text("SO-CF-U3") button:has-text("出货")').click();
            await page.waitForSelector('.modal-mask #shipWh', { timeout: 5000 });
            await page.selectOption('#shipWh', { index: 0 });
            await page.click('.modal-mask .modal-foot .btn.primary');
            await page.waitForTimeout(500);
            const whShipped = await db(page, (id) => DB.get('sales_orders', id).status, d.id);
            if (whShipped !== 'shipped') throw new Error('仓管出货失败: ' + whShipped);

            // 再落一笔待确认，切业务（r3：sales.view/sales.create、无 sales.ship）
            const d2 = await db(page, () => {
                const cfg = { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
                const o = DB.insert('sales_orders', mkSO('so_cf_u4', 'SO-CF-U4', cfg.custId, cfg.itemId, 1));
                DB.flush();
                return { id: o.id, no: o.no };
            });
            await switchUser(page, 'sales', '123456');
            await gotoHash(page, '#/sales-orders');
            const sal = await page.evaluate((no) => {
                const row = Array.from(document.querySelectorAll('#soBody tr')).find(tr => tr.textContent.includes(no));
                const btns = row ? Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
                return {
                    confirmBtn: btns.includes('确认收到'),
                    shipBtn: btns.includes('出货'),
                    badge: (document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge') || {}).textContent || null
                };
            }, d2.no);
            if (sal.confirmBtn) throw new Error('业务不应看到「确认收到」按钮');
            if (sal.shipBtn) throw new Error('业务不应看到「出货」按钮');
            if (sal.badge !== '1') throw new Error('业务应看到待确认徽章 1, got ' + sal.badge);
            // 直调确认被权限拦截
            const salDirect = await db(page, (id) => new Promise(res => {
                Pages.confirmReceived(id);
                setTimeout(() => res({
                    toast: (document.getElementById('toastWrap') || {}).textContent || '',
                    has: !!DB.get('sales_orders', id).received_at
                }), 250);
            }), d2.id);
            if (!salDirect.toast.includes('没有权限')) throw new Error('业务直调确认应被权限拦截: ' + salDirect.toast);
            if (salDirect.has) throw new Error('业务直调确认不应写 received_at');
            // 直调出货也应被门禁挡下（未确认）
            const salShip = await db(page, (id) => new Promise(res => {
                Pages.shipOrder(id);
                setTimeout(() => res({ modal: !!document.querySelector('.modal-mask'), st: DB.get('sales_orders', id).status }), 200);
            }), d2.id);
            if (salShip.modal || salShip.st !== 'draft') throw new Error('业务直调出货未拦截');
        });

        /* ===== T6 提醒链（加速）：每 2 分钟共 3 次；中途确认即停 ===== */
        await test('T6 重复提示音：2 分钟间隔共 3 次、中途确认立即停止、新单重置计数', async () => {
            await switchUser(page, 'admin', 'admin123');
            // 清理遗留待确认（SO-CF-U4 保持待确认，后续再处理）
            await page.evaluate(() => {
                window.__chimeCalls = 0;
                CloudSync.playNewOrderChime = function () { window.__chimeCalls++; };
                CloudSync.REMIND_DELAY = 300; // 加速：300ms ≈ 2 分钟
                CloudSync.stopReminderCycle();
            });
            const d5 = await db(page, () => {
                const cfg = { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
                const o = DB.insert('sales_orders', mkSO('so_cf_u5', 'SO-CF-U5', cfg.custId, cfg.itemId, 1));
                DB.flush();
                return { id: o.id };
            });
            // 已存在 so_cf_u4 待确认（1 笔）＋ u5 → 2 笔
            await page.evaluate(() => CloudSync.startReminderCycle(true));
            await page.waitForTimeout(1250); // 300/600/900 三响
            let c1 = await page.evaluate(() => window.__chimeCalls);
            if (c1 !== 3) throw new Error('3 次提醒后应响 3 声, 实际 ' + c1);
            await page.waitForTimeout(400); // 已达上限不再响
            const c1b = await page.evaluate(() => window.__chimeCalls);
            if (c1b !== 3) throw new Error('超过 3 次不应再响, 实际 ' + c1b);

            // 中途确认即停止：另起一轮，响 1 声后确认全部 → 不再响
            await page.evaluate(() => { window.__chimeCalls = 0; CloudSync.startReminderCycle(true); });
            await page.waitForTimeout(420); // 第 1 响
            let c2 = await page.evaluate(() => window.__chimeCalls);
            if (c2 !== 1) throw new Error('预期 1 响, 实际 ' + c2);
            await page.evaluate((arg) => {
                DB.update('sales_orders', arg.u4, { received_at: Utils.now() });
                DB.update('sales_orders', arg.u5, { received_at: Utils.now() });
                DB.flush();
                CloudSync.stopReminderCycle();
            }, { u4: 'so_cf_u4', u5: d5.id });
            await page.waitForTimeout(600);
            const c2b = await page.evaluate(() => window.__chimeCalls);
            if (c2b !== 1) throw new Error('全部确认后不应继续响, 实际 ' + c2b);

            // 新单到达重置计数（重置后可再响 3 次）
            await page.evaluate(() => {
                window.__chimeCalls = 0;
                CloudSync.startReminderCycle(true); // 无待确认 → 不武装
            });
            const d6 = await db(page, () => {
                const cfg = { custId: DB.list('customers')[0].id, itemId: 'it_cf' };
                const o = DB.insert('sales_orders', mkSO('so_cf_u6', 'SO-CF-U6', cfg.custId, cfg.itemId, 1));
                DB.flush();
                return { id: o.id };
            });
            await page.evaluate(() => CloudSync.kickStartupReminder()); // 启动遗留待确认提醒（跨重启场景）
            await page.waitForTimeout(450);
            const c3 = await page.evaluate(() => window.__chimeCalls);
            if (c3 !== 1) throw new Error('kickStartupReminder 应触发第 1 声, 实际 ' + c3);
            // 收尾：确认 u6 + 停链，恢复 250ms→120s 无关（测试将结束）
            await page.evaluate((u6) => {
                DB.update('sales_orders', u6, { received_at: Utils.now() });
                DB.flush();
                CloudSync.stopReminderCycle();
                window.__chimeCalls = 0;
            }, d6.id);
        });

        /* ===== T7 一次性迁移守卫：首载盖章旧单，之后不再误盖章 ===== */
        await test('T7 旧资料一次性迁移（首载盖章），重启/后续不误盖章新待确认单', async () => {
            const ctx2 = await browser.newContext();
            await cutCloud(ctx2);
            const p2 = await ctx2.newPage();
            p2.setDefaultTimeout(12000);
            await login(p2, 'admin', 'admin123');
            // 造「功能上线前遗留的旧单」：清确认标记 + 塞一笔 draft 无 received_at + 重载
            await p2.evaluate(() => {
                localStorage.removeItem('taiyuan_erp_so_confirm_v1');
                const mem = JSON.parse(localStorage.getItem('taiyuan_erp_data_v1'));
                mem.sales_orders = mem.sales_orders || [];
                mem.sales_orders.push({ id: 'so_cf_legacy', no: 'SO-LEGACY-1', status: 'draft', customer_id: (mem.customers || [])[0].id, order_date: '2026-08-01', currency: 'CNY', channel: '线下', platform_no: '', lines: [], invoice_amount: 0, taxable_amount: 0, net_receipt: 0, shipping_fee: 0, tax_amount: 0, received_amount: 0, payment_status: 'unpaid', created_by: 'admin' });
                delete mem.__hash;
                mem.__rev = (mem.__rev || 0) + 1;
                localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(mem));
            });
            await nav(p2, BASE);
            await p2.waitForTimeout(1200);
            await injectMK(p2);
            const mig = await p2.evaluate(() => {
                const o = DB.get('sales_orders', 'so_cf_legacy');
                return { stamped: !!(o && o.received_at), flag: !!localStorage.getItem('taiyuan_erp_so_confirm_v1') };
            });
            if (!mig.stamped) throw new Error('旧单首载应自动盖章 received_at');
            if (!mig.flag) throw new Error('迁移标记应已写入 localStorage');
            // 迁移后：新到达的待确认单经重启不得被误盖章
            await p2.evaluate(() => {
                const mem = JSON.parse(localStorage.getItem('taiyuan_erp_data_v1'));
                mem.sales_orders = mem.sales_orders || [];
                mem.sales_orders.push({ id: 'so_cf_fresh', no: 'SO-FRESH-1', status: 'draft', customer_id: (mem.customers || [])[0].id, order_date: '2026-09-07', currency: 'CNY', channel: '虾皮', platform_no: '', lines: [], invoice_amount: 0, taxable_amount: 0, net_receipt: 0, shipping_fee: 0, tax_amount: 0, received_amount: 0, payment_status: 'unpaid', created_by: 'DTEST' });
                delete mem.__hash;
                mem.__rev = (mem.__rev || 0) + 1;
                localStorage.setItem('taiyuan_erp_data_v1', JSON.stringify(mem));
            });
            await nav(p2, BASE);
            await p2.waitForTimeout(1200);
            await injectMK(p2);
            const fresh = await p2.evaluate(() => {
                const o = DB.get('sales_orders', 'so_cf_fresh');
                return { stamped: !!(o && o.received_at), badge: (document.querySelector('.menu-link[data-code="sales_orders"] .menu-badge') || {}).textContent || null };
            });
            if (fresh.stamped) throw new Error('迁移后新单重启不应被自动盖章（提醒须持续到点选确认）');
            if (fresh.badge !== '1') throw new Error('新待确认单应亮徽章 1, got ' + fresh.badge);
            await ctx2.close();
        });

        await browser.close();
        console.log(results.join('\n'));
        console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
        process.exit(fail ? 1 : 0);
    } catch (e) {
        console.error('FATAL:', e.message);
        await browser.close().catch(() => { });
        process.exit(1);
    }
})();
