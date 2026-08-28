// ERP 联动一致性自动化测试
// 覆盖：进货↔库存↔应付、出货↔库存↔应收、单位换算率、外币折本位币、
//       销退↔库存回补/成本冲回/收款状态、超退限制、收款/付款口径、
//       传票/费用模块移除验证、删除保护、仪表板毛利口径（会计模块已移除）
// 运行前提：本地服务器 http://127.0.0.1:8904（cd erp-clone && node serve.js 8904 .）
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8902';
let pass = 0, fail = 0, failures = [];
const errors = [];

function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}
const near = (a, b, eps) => Math.abs(UtilsNum(a) - b) < (eps === undefined ? 0.01 : eps);
function UtilsNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

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
  async function bodyText() { return await page.textContent('body'); }
  async function toastText() {
    const t = await page.locator('.toast').allTextContents().catch(() => []);
    return t.join(' | ');
  }
  // 等待并点击确认弹窗
  async function confirmOk() {
    await page.locator('#confirmOkBtn').click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // ========== 1. 登录 + 注入测试数据 ==========
  console.log('\n[1] 登录并注入联动测试数据');
  await login('admin', 'admin123');
  check((await bodyText()).includes('仪表板'), '管理员登录成功');

  await db(() => {
    // 清理可能残留的测试数据
    ['sales_returns', 'purchase_returns', 'shipments', 'sales_orders', 'purchase_orders', 'inventory_adjusts', 'expenses', 'vouchers'].forEach(k => { DB._mem[k] = []; });
    DB._mem.stock = {};
    DB.list('items').forEach(i => DB.remove('items', i.id));
    ['cu_t', 'sp_t', 'wh_tmp'].forEach(id => { DB.remove('customers', id); DB.remove('suppliers', id); DB.remove('warehouses', id); });
    // 测试商品：
    // it_a：销售→库存 1:2、采购→库存 1:3、成本 10 元（CNY）
    // it_b：采购币别 USD、成本 5 美元（本位币 36 元）、换算率 1:1
    const a = DB.insert('items', {
      id: 'it_a', code: 'LKA001', name: '联动测试A(箱)', english_name: 'Link Test A', spec: '', brand: '测试',
      model: '', category_id: 'g1', product_type: '成品',
      sales_unit: '箱', purchase_unit: '箱', stock_unit: '个', sales_to_stock: 2, purchase_to_stock: 3,
      cost: 10, price: 30, min_price: 20, purchase_currency: 'CNY',
      safety_stock: 0, max_stock: 1000, weight: 0, volume: 0, remark: '联动测试', disabled: false
    });
    const b = DB.insert('items', {
      id: 'it_b', code: 'LKB001', name: '联动测试B(美元成本)', english_name: 'Link Test B', spec: '', brand: '测试',
      model: '', category_id: 'g1', product_type: '成品',
      sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1,
      cost: 5, price: 50, min_price: 40, purchase_currency: 'USD',
      safety_stock: 0, max_stock: 1000, weight: 0, volume: 0, remark: '联动测试', disabled: false
    });
    const cu = DB.insert('customers', { id: 'cu_t', code: 'CUSTEST', name: '联动测试客户', currency: 'CNY', payment_method: '现款现货', disabled: false });
    const sp = DB.insert('suppliers', { id: 'sp_t', code: 'SUPTEST', name: '联动测试供应商', currency: 'CNY', payment_method: '现款现货', disabled: false });
    DB.addStock('wh1', a.id, 100);
    DB.addStock('wh1', b.id, 50);
    return { a: a.id, b: b.id, cu: cu.id, sp: sp.id };
  });
  const ids = await db(() => ({
    a: DB.list('items').find(i => i.code === 'LKA001').id,
    b: DB.list('items').find(i => i.code === 'LKB001').id,
    cu: DB.list('customers').find(c => c.code === 'CUSTEST').id,
    sp: DB.list('suppliers').find(s => s.code === 'SUPTEST').id
  }));
  console.log('  注入商品/客户/供应商完成，初始库存 it_a=100 it_b=50');

  // ========== 2. 采购→进货→库存→应付 联动 ==========
  console.log('\n[2] 采购单建立 → 进货入库 → 库存换算增加 + 形成应付');
  await gotoHash('#/purchase-orders/create');
  await page.locator('[name=supplier_id]').selectOption(ids.sp);
  await page.locator('#poLines tbody tr').first().locator('[name="item_id[]"]').selectOption(ids.a);
  await page.locator('#poLines tbody tr').first().locator('[name="qty[]"]').fill('5');
  await page.locator('#poLines tbody tr').first().locator('[name="unit_price[]"]').fill('8');
  await page.waitForTimeout(300);
  await page.locator('#poForm button[type=submit]').click();
  await page.waitForTimeout(900);
  const po = await db(() => {
    const o = DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, amount: o.amount, status: o.status } : null;
  });
  check(!!po && po.amount === 40, `采购单已保存 金额40 (${po ? po.no : '-'})`);
  check(po && po.status === 'draft', '采购单初始状态为未进货');
  check((await bodyText()).includes('采购单'), '保存后回到采购单列表');

  // 进货入库（确认弹窗）
  await gotoHash('#/purchase-orders');
  await page.locator(`tr:has-text("${po.no}") button:has-text("进货入库")`).click().catch(async () => {
    // 兼容按钮可能为链接
    await page.locator(`a:has-text("${po.no}")`).first().click();
    await page.waitForTimeout(500);
    await page.locator('button:has-text("进货入库")').first().click();
  });
  await page.waitForTimeout(300);
  await confirmOk();
  const stockAfterPO = await db(id => ({ ita: DB.stockOf('wh1', 'it_a'), itb: DB.stockOf('wh1', 'it_b') }));
  const poAfter = await db(id => DB.get('purchase_orders', id), po.id);
  check(near(stockAfterPO.ita, 115), `进货后 it_a 库存 = 100 + 5箱×3换算 = 115 (实际 ${stockAfterPO.ita})`);
  check(poAfter.status === 'received', '采购单状态已更新为 received（已进货）');
  const apExists = await db(() => DB.list('purchase_orders').some(o => o.status === 'received'));
  check(apExists, '应付账款数据源已形成（received 采购单）');

  // ========== 3. 销货订单(CNY) → 出货 → 库存换算扣减 + 应收 ==========
  console.log('\n[3] 销货订单(CNY) → 出货 → 库存按换算率扣减 + 应收形成');
  await gotoHash('#/sales-orders/create');
  await page.locator('[name=customer_id]').selectOption(ids.cu);
  await page.locator('[name=sales_owner]').selectOption({ index: 1 });
  await page.waitForTimeout(200);
  await page.locator('#salesLines tbody tr').first().locator('[name="item_id[]"]').selectOption(ids.a);
  await page.locator('#salesLines tbody tr').first().locator('[name="qty[]"]').fill('10');
  await page.locator('#salesLines tbody tr').first().locator('[name="unit_price[]"]').fill('30');
  await page.locator('[name=tax_rate]').fill('0');
  await page.waitForTimeout(300);
  const invUI = await page.locator('#invoiceAmount').inputValue();
  check(near(invUI, 300), `CNY 订单应收总额 = 300 (界面 ${invUI})`);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const so1 = await db(() => {
    const o = DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, inv: o.invoice_amount, currency: o.currency, status: o.status } : null;
  });
  check(!!so1 && so1.currency === 'CNY' && near(so1.inv, 300), `CNY 订单已保存 (${so1 ? so1.no : '-'})`);

  // 出货
  await gotoHash('#/sales-orders');
  await page.locator(`tr:has-text("${so1.no}") button:has-text("出货")`).first().click();
  await page.waitForTimeout(300);
  await page.locator('#shipWh').selectOption('wh1');
  await page.locator('button:has-text("确认出货")').click();
  await page.waitForTimeout(700);
  const data1 = await db(() => {
    const o = DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return { ita: DB.stockOf('wh1', 'it_a'), oid: o.id, status: o.status, sh: DB.list('shipments').length };
  });
  check(near(data1.ita, 95), `出货后 it_a 库存 = 115 - 10箱×2换算 = 95 (实际 ${data1.ita})`);
  check(data1.status === 'shipped', '订单状态已更新为 shipped（已出货）');
  check(data1.sh >= 1, '出货单已建立');

  // ========== 4. 销货订单(USD) → 出货 → 外币应收 + 本位币报表 ==========
  console.log('\n[4] 销货订单(USD 100) → 出货 → 外币应收、损益表按汇率折本位币');
  await gotoHash('#/sales-orders/create');
  await page.locator('[name=customer_id]').selectOption(ids.cu);
  await page.locator('[name=sales_owner]').selectOption({ index: 1 });
  await page.locator('[name=currency]').selectOption('USD');
  await page.locator('#salesLines tbody tr').first().locator('[name="item_id[]"]').selectOption(ids.b);
  await page.locator('#salesLines tbody tr').first().locator('[name="qty[]"]').fill('2');
  await page.locator('#salesLines tbody tr').first().locator('[name="unit_price[]"]').fill('50');
  await page.locator('[name=tax_rate]').fill('0');
  await page.waitForTimeout(300);
  const invUSD = await page.locator('#invoiceAmount').inputValue();
  check(near(invUSD, 100), `USD 订单应收总额 = 100 (界面 ${invUSD})`);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(900);
  const so2 = await db(() => {
    const o = DB.list('sales_orders').filter(x => x.currency === 'USD').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, inv: o.invoice_amount, currency: o.currency } : null;
  });
  check(!!so2 && near(so2.inv, 100), `USD 订单已保存 (${so2 ? so2.no : '-'})`);

  await gotoHash('#/sales-orders');
  await page.locator(`tr:has-text("${so2.no}") button:has-text("出货")`).first().click();
  await page.waitForTimeout(300);
  await page.locator('#shipWh').selectOption('wh1');
  await page.locator('button:has-text("确认出货")').click();
  await page.waitForTimeout(700);
  const data2 = await db(() => ({ itb: DB.stockOf('wh1', 'it_b'), o: DB.list('sales_orders').find(x => x.currency === 'USD') }));
  check(near(data2.itb, 48), `出货后 it_b 库存 = 50 - 2 = 48 (实际 ${data2.itb})`);
  check(data2.o.status === 'shipped', 'USD 订单已出货');

  // ========== 5. 经营口径（外币折本位币 + 成本乘换算率，会计模块已移除后数据层验证） ==========
  console.log('\n[5] 经营口径：营收 300 + 100×7.2 = 1020；COGS = 10×2×10 + 2×1×36 = 272');
  const inc = await db(() => {
    // 直接调用页面相同的计算逻辑（本位币口径；收入按出货日期归属）
    const month = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
    const shipIds = new Set(DB.list('shipments').filter(s => s.ship_date.startsWith(month)).map(s => s.sales_order_id));
    const shippedInMonth = DB.list('sales_orders').filter(o => o.status === 'shipped' && shipIds.has(o.id));
    const revenue = shippedInMonth.reduce((s, o) => s + toCNY(o.invoice_amount, o.currency), 0);
    const cogs = shippedInMonth.reduce((s, o) => s + o.lines.reduce((a, l) => {
      const it = DB.get('items', l.item_id);
      const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
      return a + Utils.num(l.qty) * rate * itemCostCNY(it);
    }, 0), 0);
    return { revenue, cogs, rateUSD: DB.currencyByCode('USD').rate };
  });
  check(inc.rateUSD === 7.2, 'USD 汇率 7.2 读取正常');
  check(near(inc.revenue, 1020), `营收折本位币 = 300 + 100×7.2 = 1020 (实际 ${inc.revenue})`);
  check(near(inc.cogs, 272), `销货成本 = 10箱×2×10 + 2个×1×36 = 272 (实际 ${inc.cogs})`);

  // ========== 6. 销货退回 → 库存回补 + 成本冲回 + 应收冲减 + 收款状态回写 ==========
  console.log('\n[6] 销货退回：库存回补(×换算率)、成本冲回(折本位币)、冲减应收、收款状态回写');
  await gotoHash('#/sales-returns/create');
  await page.locator('#srSo').selectOption({ value: so1.id });
  await page.waitForTimeout(200);
  await page.locator('button:has-text("从订单带出明细")').click();
  await page.waitForTimeout(300);
  await page.locator('#srLines tbody tr').first().locator('[name="qty[]"]').fill('2');
  await page.locator('[name=offset_receivable]').selectOption('1');
  await page.waitForTimeout(200);
  await page.locator('#srForm button[type=submit]').click();
  await page.waitForTimeout(900);
  const sr = await db(() => {
    const r = DB.list('sales_returns').sort((a, b) => b.no.localeCompare(a.no))[0];
    return r ? { id: r.id, no: r.no, total: r.total_amount, cost: r.cost_reversal, offset: r.offset_receivable, soId: r.sales_order_id } : null;
  });
  const afterSR = await db(() => {
    const r = DB.list('sales_returns')[0];
    const o = DB.get('sales_orders', r.sales_order_id);
    return { ita: DB.stockOf('wh1', 'it_a'), status: o.payment_status, received: o.received_amount };
  });
  check(!!sr && near(sr.total, 60), `销退金额 = 2箱×30 = 60 (${sr ? sr.no : '-'})`);
  check(sr && near(sr.cost, 40), `成本冲回 = 2×2换算×10 = 40 本位币 (实际 ${sr.cost})`);
  check(afterSR.ita === 99, `销退后 it_a 库存 = 95 + 2箱×2换算 = 99 (实际 ${afterSR.ita})`);
  check(sr && sr.offset === true, '销退冲减应收标记正确');
  check((afterSR.received || 0) === 0 && afterSR.status === 'unpaid', `订单收款状态回写：应收被冲减后未收款状态 (${afterSR.status})`);

  // ========== 7. 超退限制 ==========
  console.log('\n[7] 超退限制：累计退回不得超过订单出货数量');
  await gotoHash('#/sales-returns/create');
  await page.locator('#srSo').selectOption({ value: so1.id });
  await page.waitForTimeout(200);
  await page.locator('button:has-text("从订单带出明细")').click();
  await page.waitForTimeout(300);
  await page.locator('#srLines tbody tr').first().locator('[name="qty[]"]').fill('9'); // 已退2，再退9 > 10
  await page.locator('[name=offset_receivable]').selectOption('1');
  await page.waitForTimeout(200);
  await page.locator('#srForm button[type=submit]').click();
  await page.waitForTimeout(700);
  const overText = await bodyText();
  const overToast = await toastText();
  const srCount = await db(() => DB.list('sales_returns').length);
  check(overToast.includes('累计退回') || overToast.includes('无法保存'), `超退被拒绝 (toast: ${overToast || overText.slice(0, 80)})`);
  check(srCount === 1, `超退未保存（销退单仍为 1 笔）`);

  // ========== 8. 收款联动：未收口径(含退货冲减) + 超收拒绝 + 方式/日期保存 ==========
  console.log('\n[8] 收款：未收 = 应收300 - 退货60 = 240；超收拒绝；收款方式/日期入账');
  await gotoHash('#/accounting/accounts-receivable');
  await page.locator(`tr:has-text("${so1.no}") button:has-text("登记收款")`).first().click();
  await page.waitForTimeout(300);
  const modalOutstanding = await page.locator('.modal input[readonly]').nth(1).inputValue().catch(() => '');
  check(near(modalOutstanding, 240), `收款弹窗未收金额 = 240（已扣退货冲减，界面 ${modalOutstanding})`);
  // 超收拒绝
  await page.locator('#payAmount').fill('300');
  await page.locator('.modal button:has-text("确认收款")').click();
  await page.waitForTimeout(500);
  const overPayToast = await toastText();
  check(overPayToast.includes('不能超过未收'), `超收被拒绝 (${overPayToast})`);
  // 正常收款 100
  await page.locator('#payAmount').fill('100');
  await page.locator('#payMethod').selectOption('支付宝');
  await page.locator('#payDate').fill('2026-08-19');
  await page.locator('.modal button:has-text("确认收款")').click();
  await page.waitForTimeout(700);
  const payInfo = await db(id => {
    const o = DB.get('sales_orders', id);
    return { received: o.received_amount, status: o.payment_status, method: o.payment_method, date: o.payment_date };
  }, so1.id);
  check(near(payInfo.received, 100), `已收金额 = 100 (实际 ${payInfo.received})`);
  check(payInfo.status === 'partial', `收款状态 = partial (${payInfo.status})`);
  check(payInfo.method === '支付宝' && payInfo.date === '2026-08-19', `收款方式/日期已入账 (${payInfo.method}/${payInfo.date})`);

  // ========== 9. 付款联动：未付口径 + 方式/日期保存 ==========
  console.log('\n[9] 付款：采购单 40 全额付清、付款方式/日期入账');
  await gotoHash('#/accounting/accounts-payable');
  await page.locator(`tr:has-text("${po.no}") button:has-text("登记付款")`).first().click();
  await page.waitForTimeout(300);
  await page.locator('#payAmountPO').fill('40');
  await page.locator('#payMethodPO').selectOption('银行转账');
  await page.locator('#payDatePO').fill('2026-08-19');
  await page.locator('.modal button:has-text("确认付款")').click();
  await page.waitForTimeout(700);
  const payPONow = await db(id => {
    const o = DB.get('purchase_orders', id);
    return { paid: o.paid_amount, status: o.payment_status, method: o.payment_method, date: o.payment_date };
  }, po.id);
  check(near(payPONow.paid, 40), `已付金额 = 40 (实际 ${payPONow.paid})`);
  check(payPONow.status === 'paid', `付款状态 = paid (${payPONow.status})`);
  check(payPONow.method === '银行转账' && payPONow.date === '2026-08-19', `付款方式/日期已入账 (${payPONow.method}/${payPONow.date})`);

  // ========== 10. 传票/费用模块已移除 ==========
  console.log('\n[10] 传票/费用模块已移除：路由回首页 + 集合清空');
  await gotoHash('#/accounting/vouchers/create');
  const vGoneText = (await toastText()) + (await bodyText());
  check(vGoneText.includes('找不到该页面') || vGoneText.includes('上线检核仪表板'), '传票新增路由已移除');
  await gotoHash('#/accounting/vouchers');
  const vGoneText2 = (await toastText()) + (await bodyText());
  check(vGoneText2.includes('找不到该页面') || vGoneText2.includes('上线检核仪表板'), '传票列表路由已移除');
  await gotoHash('#/expenses/create');
  const exGoneText = (await toastText()) + (await bodyText());
  check(exGoneText.includes('找不到该页面') || exGoneText.includes('上线检核仪表板'), '费用支出路由已移除');
  const collEmpty = await db(() => DB.list('vouchers').length === 0 && DB.list('expenses').length === 0 && DB.list('chart_accounts').length === 0);
  check(collEmpty, 'vouchers/expenses/chart_accounts 集合均为空');

  // ========== 11. 删除保护 ==========
  console.log('\n[11] 删除保护：仓库有库存禁删、币别被引用禁删、客户被引用禁删、空仓库可删');
  // 说明：deleteMaster 引用检查在确认弹窗之前直接 toast 拒绝，因此点删除后直接断言 toast
  // 仓库 wh1 有库存 → 禁删
  await gotoHash('#/master/warehouses');
  await page.locator(`tr:has-text("WH001") button:has-text("删除")`).click();
  await page.waitForTimeout(400);
  const whToast = await toastText();
  check(whToast.includes('已被引用') || whToast.includes('无法删除'), `有库存仓库删除被拒 (${whToast || '无提示'})`);
  const whStill = await db(() => DB.list('warehouses').some(w => w.id === 'wh1'));
  check(whStill, 'wh1 仓库仍存在');

  // 币别 USD 被订单引用 → 禁删
  await gotoHash('#/master/currencies');
  await page.locator(`tr:has-text("USD") button:has-text("删除")`).click();
  await page.waitForTimeout(400);
  const curToast = await toastText();
  check(curToast.includes('已被引用') || curToast.includes('无法删除'), `被订单引用币别删除被拒 (${curToast || '无提示'})`);
  const curStill = await db(() => DB.list('currencies').some(c => c.code === 'USD'));
  check(curStill, 'USD 币别仍存在');

  // 客户 cu_t 被订单引用 → 禁删（客户列表为卡片布局）
  await gotoHash('#/master/customers');
  await page.locator(`.master-card:has-text("CUSTEST") button:has-text("删除")`).click();
  await page.waitForTimeout(400);
  const cuToast = await toastText();
  check(cuToast.includes('已被引用') || cuToast.includes('无法删除'), `被引用客户删除被拒 (${cuToast || '无提示'})`);

  // 空仓库可删除（无引用 → 弹确认框 → 确认后删除成功）
  await db(() => DB.insert('warehouses', { id: 'wh_tmp', code: 'WHTMP', name: '临时空仓库', contact: '', phone: '', address: '', remark: '', created_at: Utils.now(), updated_at: Utils.now() }));
  await gotoHash('#/master/warehouses');
  await page.locator(`tr:has-text("WHTMP") button:has-text("删除")`).click();
  await page.waitForTimeout(300);
  await confirmOk();
  const tmpGone = await db(() => !DB.list('warehouses').some(w => w.id === 'wh_tmp'));
  check(tmpGone, '无库存空仓库可正常删除');

  // ========== 12. 仪表板本月毛利口径（损益表已移除，毛利 = 净营收 - 销货成本净额） ==========
  console.log('\n[12] 仪表板本月毛利 = (营收1020 - 退货60) - (成本272 - 成本冲回40) = 728');
  const expectProfit = (1020 - 60) - (272 - 40);
  await gotoHash('#/dashboard');
  const dashText = await bodyText();
  const dashProfitMatch = dashText.match(/本月毛利\s*([\d,.-]+)/);
  const dashProfit = dashProfitMatch ? parseFloat(dashProfitMatch[1].replace(/,/g, '')) : NaN;
  check(near(dashProfit, expectProfit), `仪表板本月毛利 = ${expectProfit} (实际 ${dashProfit})`);
  check(!dashText.includes('损益表'), '仪表板不再出现损益表入口/文案');

  // ========== 汇总 ==========
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass} 项 / 失败 ${fail} 项`);
  if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  -', f)); }
  if (errors.length) {
    console.log(`\n页面错误 ${errors.length} 条（前 5 条）：`);
    errors.slice(0, 5).forEach(e => console.log('  -', e));
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('测试崩溃:', err); process.exit(2); });
