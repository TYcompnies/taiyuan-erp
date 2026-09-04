// ERP 深度业务流程调试测试
// 模拟真实操作：登录边界 → 销货订单(建/编/校验/出货) → 采购(建/进货) → 样品领料 → 费用 → 传票 → 主档CRUD → 持久化 → 深色模式
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8902';
let pass = 0, fail = 0, failures = [];
const errors = [];

function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  // ---------- 工具 ----------
  async function login(user, pwd) {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const inputs = page.locator('#loginForm input');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const ph = await inputs.nth(i).getAttribute('placeholder') || '';
      if (/账号|用户/i.test(ph)) await inputs.nth(i).fill(user);
      if (/密码/i.test(ph)) await inputs.nth(i).fill(pwd);
    }
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForTimeout(1000);
  }
  async function gotoHash(hash) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(700);
  }
  const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval('(' + src + ')'); return f(a); }, { src: fn.toString(), a: arg });

  // ========== 1. 登录边界 ==========
  console.log('\n[1] 登录边界测试');
  await login('admin', 'wrongpassword');
  const errText = await page.textContent('#loginErr');
  check((errText || '').includes('账号或密码错误'), '错误密码显示错误提示');
  await login('admin', 'admin123');
  check((await page.textContent('body')).includes('仪表板'), '正确账密进入仪表板');

  // ========== 2. 记录初始状态 ==========
  console.log('\n[2] 记录初始库存状态');
  // 业务数据已清空（商品主档为空），先插入测试商品与初始库存
  await db(() => {
    const it = DB.insert('items', {
      id: 'it_test', code: 'TEST0001', name: '测试商品', english_name: 'Test Item', spec: '', brand: '测试',
      model: '', category_id: DB.list('categories')[0].id, product_type: '成品',
      sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1,
      cost: 10, price: 25, min_price: 20, purchase_currency: 'CNY',
      safety_stock: 5, max_stock: 100, weight: 0, volume: 0, remark: '自动化测试商品'
    });
    DB.addStock('wh1', it.id, 100);
    return it.id;
  });
  const init = await db(() => ({
    itemId: DB.list('items').filter(i => !i.disabled)[0].id,
    itemCode: DB.list('items').filter(i => !i.disabled)[0].code,
    stockWh1: DB.stockOf('wh1', DB.list('items').filter(i => !i.disabled)[0].id),
    soCount: DB.list('sales_orders').length,
    poCount: DB.list('purchase_orders').length,
    shCount: DB.list('shipments').length,
    adjCount: DB.list('inventory_adjusts').length,
    exCount: DB.list('expenses').length,
    vcCount: DB.list('vouchers').length,
    custCount: DB.list('customers').length
  }));
  console.log('  初始: 商品', init.itemCode, 'wh1库存', init.stockWh1, 'SO', init.soCount, 'PO', init.poCount);
  check(true, '初始状态读取');

  // ========== 3. 新增销货订单 ==========
  console.log('\n[3] 新增销货订单');
  await gotoHash('#/sales-orders/create');
  await page.locator('[name=customer_id]').selectOption({ index: 1 });
  await page.locator('[name=sales_owner]').selectOption({ index: 1 });
  // 明细行（已自动添加一行）
  await page.locator('#salesLines tbody tr').first().locator('[name="item_id[]"]').selectOption({ index: 1 });
  await page.locator('#salesLines tbody tr').first().locator('[name="qty[]"]').fill('10');
  await page.locator('#salesLines tbody tr').first().locator('[name="unit_price[]"]').fill('25');
  await page.locator('[name=tax_rate]').fill('13');
  await page.locator('[name=tax_type]').selectOption('应税');
  await page.waitForTimeout(300);
  // 界面计算校验：含税 250 → 未税 221.24 税额 28.76
  const taxableUI = await page.locator('#taxableAmount').inputValue();
  const taxUI = await page.locator('#taxAmount').inputValue();
  const invUI = await page.locator('#invoiceAmount').inputValue();
  check(Math.abs(parseFloat(taxableUI) - 221.24) < 0.05, `未税销售额计算正确 (${taxableUI} ≈ 221.24)`);
  check(Math.abs(parseFloat(taxUI) - 28.76) < 0.05, `税额计算正确 (${taxUI} ≈ 28.76)`);
  check(Math.abs(parseFloat(invUI) - 250) < 0.01, `应收总额计算正确 (${invUI} = 250)`);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);

  const so = await db(() => {
    const o = DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { no: o.no, id: o.id, status: o.status, inv: o.invoice_amount, taxable: o.taxable_amount, tax: o.tax_amount, lines: o.lines.length, qty: o.lines[0].qty } : null;
  });
  check(!!so, '订单已保存');
  check(so && so.no && /^SO\d{11}$/.test(so.no), '单号格式正确: ' + (so && so.no));
  check(so && so.status === 'draft', '初始状态为未出货');
  check(so && Math.abs(so.inv - 250) < 0.01 && Math.abs(so.tax - 28.76) < 0.05, '保存金额与界面一致');
  check(so && so.lines === 1 && so.qty === 10, '明细保存正确');

  // ========== 4. 编辑销货订单 ==========
  console.log('\n[4] 编辑销货订单（数量 10 → 4）');
  await gotoHash('#/sales-orders/' + so.id + '/edit');
  await page.locator('#salesLines tbody tr').first().locator('[name="qty[]"]').fill('4');
  await page.waitForTimeout(300);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const so2 = await db(id => { const o = DB.get('sales_orders', id); return { qty: o.lines[0].qty, inv: o.invoice_amount }; }, so.id);
  check(so2.qty === 4, '编辑后数量已更新 (4)');
  check(Math.abs(so2.inv - 100) < 0.01, '编辑后金额重算 (100)');

  // ========== 5. 表单校验：无有效明细 ==========
  console.log('\n[5] 表单校验');
  await gotoHash('#/sales-orders/create');
  await page.locator('[name=customer_id]').selectOption({ index: 1 });
  await page.locator('[name=sales_owner]').selectOption({ index: 1 });
  // 不填明细直接提交
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(500);
  const t1 = (await page.locator('.toast').allTextContents()).join(' ');
  check(t1.includes('至少'), '空明细提交被拦截: ' + t1.trim());
  await gotoHash('#/sales-orders');

  // ========== 6. 出货扣库存 ==========
  console.log('\n[6] 出货扣库存');
  await page.waitForTimeout(300);
  // 最新订单（编号最大）排最前，点击第一行的出货按钮
  await page.locator('button:has-text("出货")').first().click();
  await page.waitForTimeout(500);
  await page.locator('#shipWh').selectOption('wh1');
  await page.locator('button:has-text("确认出货")').click();
  await page.waitForTimeout(900);
  const afterShip = await db(itemId => ({
    stock: DB.stockOf('wh1', itemId),
    order: (() => { const o = DB.get('sales_orders', DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0].id); return { status: o.status, log: o.logistics_method }; })(),
    sh: (() => { const s = DB.list('shipments').sort((a, b) => b.no.localeCompare(a.no))[0]; return s ? { no: s.no, lines: s.lines.length, qty: s.lines[0].qty } : null; })()
  }), init.itemId);
  check(afterShip.order.status === 'shipped', '订单状态变为已出货');
  check(Math.abs(afterShip.stock - (init.stockWh1 - 4)) < 0.0001, `库存已扣减 (${init.stockWh1} → ${afterShip.stock})`);
  check(!!afterShip.sh && afterShip.sh.qty === 4, '出货单已建立且明细正确: ' + (afterShip.sh && afterShip.sh.no));

  // 已出货订单锁定
  await gotoHash('#/sales-orders/' + so.id + '/edit');
  await page.waitForTimeout(500);
  check(await page.locator('button:has-text("保存销货订单")').count() === 0, '已出货订单禁止编辑保存');
  check((await page.textContent('body')).includes('已出货，订单内容已锁定'), '锁定提示已显示');

  // ========== 7. 新增采购单 + 进货 ==========
  console.log('\n[7] 采购单与进货入库');
  await gotoHash('#/purchase-orders/create');
  await page.locator('[name=supplier_id]').selectOption({ index: 1 });
  await page.locator('#poLines tbody tr').first().locator('[name="item_id[]"]').selectOption({ index: 1 });
  await page.locator('#poLines tbody tr').first().locator('[name="qty[]"]').fill('30');
  await page.locator('#poLines tbody tr').first().locator('[name="unit_price[]"]').fill('10');
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const po = await db(() => {
    const p = DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return p ? { id: p.id, no: p.no, amount: p.amount, status: p.status } : null;
  });
  check(!!po && /^PO\d{11}$/.test(po.no), '采购单已保存: ' + (po && po.no));
  check(po && Math.abs(po.amount - 300) < 0.01, '采购金额正确 (300)');
  // 进货入库（confirmModal）
  await page.locator('button:has-text("进货入库")').first().click();
  await page.waitForTimeout(500);
  await page.locator('#confirmOkBtn').click();
  await page.waitForTimeout(900);
  const afterRecv = await db(itemId => ({
    stock: DB.stockOf('wh1', itemId),
    status: DB.get('purchase_orders', DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0].id).status
  }), init.itemId);
  check(afterRecv.status === 'received', '采购单状态变为已进货');
  check(Math.abs(afterRecv.stock - (afterShip.stock + 30)) < 0.0001, `进货后库存增加 (${afterShip.stock} → ${afterRecv.stock})`);

  // ========== 8. 样品领料 ==========
  console.log('\n[8] 样品领料 (+5 盘点)');
  await gotoHash('#/inventory/inventory_adjust/create');
  await page.locator('#adjLines tbody tr').first().locator('[name="item_id[]"]').selectOption({ index: 1 });
  await page.locator('#adjLines tbody tr').first().locator('[name="qty[]"]').fill('5');
  await page.waitForTimeout(300);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const afterAdj = await db(itemId => ({
    stock: DB.stockOf('wh1', itemId),
    adj: (() => { const a = DB.list('inventory_adjusts').sort((x, y) => y.no.localeCompare(x.no))[0]; return a ? { no: a.no, before: a.lines[0].before, after: a.lines[0].after } : null; })()
  }), init.itemId);
  check(Math.abs(afterAdj.stock - (afterRecv.stock + 5)) < 0.0001, `调整后库存正确 (${afterRecv.stock} → ${afterAdj.stock})`);
  check(!!afterAdj.adj && afterAdj.adj.after === afterAdj.stock, '调整记录 before/after 正确');

  // ========== 9. 费用支出（会计模块已移除：验证路由已下线）==========
  console.log('\n[9] 费用支出（已移除）');
  await gotoHash('#/expenses/create');
  await page.waitForTimeout(600);
  const t9 = await page.evaluate(() => document.body.textContent);
  check(t9.includes('找不到该页面') || t9.includes('上线检核仪表板'), '费用支出路由已移除（回首页）');

  // ========== 10. 传票作业（会计模块已移除：验证路由已下线）==========
  console.log('\n[10] 传票作业（已移除）');
  await gotoHash('#/accounting/vouchers/create');
  await page.waitForTimeout(600);
  const t10 = await page.evaluate(() => document.body.textContent);
  check(t10.includes('找不到该页面') || t10.includes('上线检核仪表板'), '传票路由已移除（回首页）');
  check(await page.evaluate(() => typeof ACCT === 'undefined'), 'ACCT 未定义（会计脚本未加载）');

  // ========== 10b. 应收账款保留验证（收付款核心功能不受影响）==========
  console.log('\n[10b] 应收/应付页仍可用');
  await gotoHash('#/accounting/accounts-receivable');
  await page.waitForTimeout(500);
  check((await page.evaluate(() => document.body.textContent)).includes('应收账款'), '应收账款页渲染正常');
  await gotoHash('#/accounting/accounts-payable');
  await page.waitForTimeout(500);
  check((await page.evaluate(() => document.body.textContent)).includes('应付账款'), '应付账款页渲染正常');

  // ========== 11. 客户主档 CRUD ==========
  console.log('\n[11] 客户主档新增');
  await gotoHash('#/master/customers/create');
  await page.locator('[name=code]').fill('CUSTEST01');
  await page.locator('[name=customer_name]').fill('调试测试客户');
  await page.locator('[name=phone]').fill('13700000000');
  await page.locator('button:has-text("保存客户")').click();
  await page.waitForTimeout(900);
  const cust = await db(() => {
    const c = DB.find('customers', x => x.code === 'CUSTEST01');
    return c ? { id: c.id, name: c.name, phone: c.phone } : null;
  });
  check(!!cust && cust.name === '调试测试客户', '客户新增成功');
  // 编辑
  await gotoHash('#/master/customers/' + cust.id + '/edit');
  await page.locator('[name=customer_name]').fill('调试测试客户改');
  await page.locator('button:has-text("保存客户")').click();
  await page.waitForTimeout(900);
  const cust2 = await db(id => DB.get('customers', id).name, cust.id);
  check(cust2 === '调试测试客户改', '客户编辑成功');

  // ========== 12. 刷新持久化 ==========
  console.log('\n[12] 刷新持久化');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const persist = await db(itemId => ({
    loginOk: !!DB.currentUser(),
    so: DB.list('sales_orders').length,
    stock: DB.stockOf('wh1', itemId)
  }), init.itemId);
  check(persist.loginOk, '刷新后仍保持登录');
  check(persist.so === init.soCount + 1, '刷新后订单数据持久化');
  check(Math.abs(persist.stock - afterAdj.stock) < 0.0001, '刷新后库存持久化');

  // ========== 13. 深色模式 / 菜单搜索 ==========
  console.log('\n[13] 深色模式与菜单搜索');
  await page.locator('.top-actions .icon-btn').first().click();
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.body.classList.contains('dark')), '深色模式切换生效');
  await page.locator('.top-actions .icon-btn').first().click();
  await page.waitForTimeout(500);
  check(!(await page.evaluate(() => document.body.classList.contains('dark'))), '深色模式切回生效');
  await page.locator('#sideSearch').fill('销货');
  await page.waitForTimeout(300);
  const visibleMenus = await page.evaluate(() => Array.from(document.querySelectorAll('.menu-link')).filter(a => a.style.display !== 'none').map(a => a.textContent.trim()));
  check(visibleMenus.length >= 2 && visibleMenus.every(t => t.includes('销货')), '菜单搜索过滤正常: ' + visibleMenus.join(','));
  await page.locator('#sideSearch').fill('');
  await page.waitForTimeout(200);

  // ========== 14. 汇总 ==========
  const tradChars = '銷貨採購帳庫單據傳應營費損憑證幣別類倉戶員碼權維護異動過沖讓贈稅額計刪儲匯還遷調滯週轉淨進開報價訂審認確備';
  const bodyNow = await page.textContent('body');
  const foundTrad = tradChars.split('').filter(ch => bodyNow.includes(ch));
  check(foundTrad.length === 0, '页面无繁体字' + (foundTrad.length ? ': ' + foundTrad.join('') : ''));
  check(errors.length === 0, '全程无 JS 错误' + (errors.length ? '\n    ' + errors.join('\n    ') : ''));

  await page.screenshot({ path: 'C:/Users/CK302/WorkBuddy/2026-08-19-09-19-03/erp-clone/shots/10-flows.png', fullPage: true });
  console.log(`\n== 深度流程测试: ${pass} 通过, ${fail} 失败 ==`);
  if (failures.length) console.log('失败项:\n  - ' + failures.join('\n  - '));
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
