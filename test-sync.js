// ERP 表单实时联动测试（输入数值后相关字段自动更新）
// 覆盖：销退/采退选择订单自动带出明细、明细数量输入实时重算行金额与合计、
//       收款/付款弹窗输入金额后余额实时更新、订单/采购单表单原有联动回归
// 运行前提：本地服务器 http://127.0.0.1:8902
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8902';
let pass = 0, fail = 0, failures = [];
const errors = [];

function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}
const near = (a, b, eps) => Math.abs(parseFloat(a || 0) - b) < (eps === undefined ? 0.01 : eps);

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

  // ========== 1. 登录 + 注入测试数据 ==========
  console.log('\n[1] 登录并注入测试数据');
  await login('admin', 'admin123');
  check((await bodyText()).includes('仪表板'), '管理员登录成功');

  await db(() => {
    ['sales_returns', 'purchase_returns', 'shipments', 'sales_orders', 'purchase_orders', 'inventory_adjusts', 'expenses', 'vouchers'].forEach(k => { DB._mem[k] = []; });
    DB._mem.stock = {};
    DB.list('items').forEach(i => DB.remove('items', i.id));
    ['cu_t', 'sp_t'].forEach(id => { DB.remove('customers', id); DB.remove('suppliers', id); });
    DB.insert('items', {
      id: 'it_a', code: 'SYN001', name: '同步测试A', english_name: '', spec: '', brand: '测试', model: '',
      category_id: 'g1', product_type: '成品',
      sales_unit: '个', purchase_unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1,
      cost: 10, price: 30, min_price: 20, purchase_currency: 'CNY',
      safety_stock: 0, max_stock: 1000, weight: 0, volume: 0, remark: '', disabled: false
    });
    DB.insert('customers', { id: 'cu_t', code: 'CUSTEST', name: '同步测试客户', currency: 'CNY', payment_method: '现款现货', disabled: false });
    DB.insert('suppliers', { id: 'sp_t', code: 'SUPTEST', name: '同步测试供应商', currency: 'CNY', payment_method: '现款现货', disabled: false });
    DB.addStock('wh1', 'it_a', 100);
  });
  const ids = await db(() => ({
    a: DB.list('items').find(i => i.code === 'SYN001').id,
    cu: DB.list('customers').find(c => c.code === 'CUSTEST').id,
    sp: DB.list('suppliers').find(s => s.code === 'SUPTEST').id
  }));
  console.log('  注入完成：商品 SYN001 / 测试客户 / 测试供应商 / 初始库存 100');

  // ========== 2. 采购单表单：数量/单价输入 → 行金额与合计实时更新（回归） ==========
  console.log('\n[2] 采购单表单：输入数量/单价后行金额与合计实时更新（回归验证）');
  await gotoHash('#/purchase-orders/create');
  await page.locator('[name=supplier_id]').selectOption(ids.sp);
  await page.locator('[name=warehouse_id]').selectOption('wh1');
  const poRow = page.locator('#poLines tbody tr').first();
  await poRow.locator('[name="item_id[]"]').selectOption(ids.a);
  await poRow.locator('[name="qty[]"]').fill('5');
  await poRow.locator('[name="unit_price[]"]').fill('8');
  await page.waitForTimeout(300);
  check(near(await poRow.locator('.line-amount').textContent(), 40), '采购明细行金额实时 = 40');
  check(near(await page.locator('#poTotal').textContent(), 40), '采购合计实时 = 40');
  await page.locator('#poForm button[type=submit]').click();
  await page.waitForTimeout(900);
  const po = await db(() => {
    const o = DB.list('purchase_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, amount: o.amount } : null;
  });
  check(!!po && po.amount === 40, `采购单已保存 (${po ? po.no : '-'})`);
  // 进货
  await gotoHash('#/purchase-orders');
  await page.locator(`tr:has-text("${po.no}") button:has-text("进货入库")`).click();
  await page.waitForTimeout(600);
  await page.locator('.modal-mask #confirmOkBtn').click();
  await page.waitForTimeout(900);

  // ========== 3. 销货订单表单：数量/单价输入 → 行金额与总计实时更新（回归） ==========
  console.log('\n[3] 销货订单表单：输入数量/单价后行金额与总计实时更新（回归验证）');
  await gotoHash('#/sales-orders/create');
  await page.locator('[name=customer_id]').selectOption(ids.cu);
  await page.locator('[name=sales_owner]').selectOption({ index: 1 });
  const soRow = page.locator('#salesLines tbody tr').first();
  await soRow.locator('[name="item_id[]"]').selectOption(ids.a);
  await soRow.locator('[name="qty[]"]').fill('2');
  await soRow.locator('[name="unit_price[]"]').fill('30');
  await page.waitForTimeout(300);
  check(near(await soRow.locator('.line-amount').textContent(), 60), '销货行金额实时 = 60');
  check(near(await page.locator('#salesTotal').textContent(), 60), '销货货款总计实时 = 60');
  check(near(await page.locator('#invoiceAmount').inputValue(), 60), '发票金额实时 = 60');
  await page.locator('#salesOrderForm button[type=submit]').click();
  await page.waitForTimeout(900);
  const so = await db(() => {
    const o = DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0];
    return o ? { id: o.id, no: o.no, amount: o.invoice_amount } : null;
  });
  check(!!so && near(so.amount, 60), `销货订单已保存 (${so ? so.no : '-'})`);
  // 出货
  await gotoHash('#/sales-orders');
  await page.locator(`tr:has-text("${so.no}") button:has-text("出货")`).first().click();
  await page.waitForTimeout(600);
  await page.locator('.modal-mask button:has-text("确认出货")').click();
  await page.waitForTimeout(900);
  const soStatus = await db(() => DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0].status);
  check(soStatus === 'shipped', '订单已出货');

  // ========== 4. 销货退回：选择订单自动带出明细 + 数量输入实时重算 ==========
  console.log('\n[4] 销货退回表单：选择订单明细自动带出；修改数量后行金额/合计实时更新');
  await gotoHash('#/sales-returns/create');
  await page.locator('#srSo').selectOption({ label: await db(() => DB.list('sales_orders').sort((a, b) => b.no.localeCompare(a.no))[0].no + ' - 同步测试客户') }).catch(async () => {
    // 兜底：按值选择（第一个非空选项）
    const optVal = await page.evaluate(() => {
      const s = document.getElementById('srSo');
      return s.options.length > 1 ? s.options[1].value : '';
    });
    await page.locator('#srSo').selectOption(optVal);
  });
  await page.waitForTimeout(600);
  const srRow = page.locator('#srLines tbody tr').first();
  check(await page.locator('#srLines tbody tr').count() >= 1, '选择订单后明细自动带出（无需手动点按钮）');
  check(near(await srRow.locator('.line-amount').textContent(), 60), '带出明细行金额 = 60');
  check(near(await page.locator('#srTotal').textContent(), 60), '带出明细合计 = 60');
  // 修改数量 2 → 1，行金额应变 30
  await srRow.locator('[name="qty[]"]').fill('1');
  await page.waitForTimeout(300);
  check(near(await srRow.locator('.line-amount').textContent(), 30), '数量改为 1 后行金额实时 = 30');
  check(near(await page.locator('#srTotal').textContent(), 30), '数量改为 1 后合计实时 = 30');

  // ========== 5. 采购退回：选择采购单自动带出明细 + 数量输入实时重算 ==========
  console.log('\n[5] 采购退回表单：选择采购单明细自动带出；修改数量后行金额/合计实时更新');
  await gotoHash('#/purchase-returns/create');
  await page.evaluate(() => {
    const s = document.getElementById('prPo');
    if (s.options.length > 1) { s.selectedIndex = 1; s.dispatchEvent(new Event('change')); }
  });
  await page.waitForTimeout(600);
  const prRow = page.locator('#prLines tbody tr').first();
  check(await page.locator('#prLines tbody tr').count() >= 1, '选择采购单后明细自动带出（无需手动点按钮）');
  check(near(await prRow.locator('.line-amount').textContent(), 40), '带出明细行金额 = 40');
  check(near(await page.locator('#prTotal').textContent(), 40), '带出明细合计 = 40');
  // 修改数量 5 → 2，行金额应变 16
  await prRow.locator('[name="qty[]"]').fill('2');
  await page.waitForTimeout(300);
  check(near(await prRow.locator('.line-amount').textContent(), 16), '数量改为 2 后行金额实时 = 16');
  check(near(await page.locator('#prTotal').textContent(), 16), '数量改为 2 后合计实时 = 16');

  // ========== 6. 收款弹窗：输入金额后收后未收余额实时更新 ==========
  console.log('\n[6] 收款弹窗：输入收款金额后收后未收余额实时更新');
  await gotoHash('#/accounting/accounts-receivable');
  await page.locator('button:has-text("登记收款")').first().click();
  await page.waitForTimeout(600);
  check(await page.locator('#payRemain').count() === 1, '收后未收余额字段存在');
  check(near(await page.locator('#payRemain').inputValue(), 60), '初始收后未收余额 = 60');
  await page.locator('#payAmount').fill('20');
  await page.waitForTimeout(300);
  check(near(await page.locator('#payRemain').inputValue(), 40), '输入收款 20 后余额实时 = 40');
  await page.locator('#payAmount').fill('60');
  await page.waitForTimeout(300);
  check(near(await page.locator('#payRemain').inputValue(), 0), '输入收款 60 后余额实时 = 0');
  await page.locator('.modal-mask .btn.primary').click();
  await page.waitForTimeout(700);

  // ========== 7. 付款弹窗：输入金额后付后未付余额实时更新 ==========
  console.log('\n[7] 付款弹窗：输入付款金额后付后未付余额实时更新');
  await gotoHash('#/accounting/accounts-payable');
  await page.locator('button:has-text("登记付款")').first().click();
  await page.waitForTimeout(600);
  check(await page.locator('#payRemainPO').count() === 1, '付后未付余额字段存在');
  check(near(await page.locator('#payRemainPO').inputValue(), 40), '初始付后未付余额 = 40');
  await page.locator('#payAmountPO').fill('30');
  await page.waitForTimeout(300);
  check(near(await page.locator('#payRemainPO').inputValue(), 10), '输入付款 30 后余额实时 = 10');
  await page.locator('.modal-mask .btn.primary').click();
  await page.waitForTimeout(700);

  // ========== 8. 库存调整：数量输入后异动前/异动后实时预览（回归） ==========
  console.log('\n[8] 库存调整表单：数量输入后异动前后实时预览（回归验证）');
  await gotoHash('#/inventory/inventory_adjust/create');
  const adjRow = page.locator('#adjLines tbody tr').first();
  await adjRow.locator('[name="item_id[]"]').selectOption(ids.a);
  await adjRow.locator('[name="qty[]"]').fill('-5');
  await page.waitForTimeout(300);
  check(near(await adjRow.locator('.before-qty').textContent(), 103, 0.001), '异动前库存实时 = 103');
  check(near(await adjRow.locator('.after-qty').textContent(), 98, 0.001), '异动后库存实时 = 98');

  // ========== 9. 传票：借贷输入后合计实时更新（回归） ==========
  console.log('\n[9] 传票表单：借贷输入后合计与差额实时更新（回归验证）');
  await gotoHash('#/accounting/vouchers/create');
  const debitInput = page.locator('input[name="debit[]"]').first();
  const creditInput = page.locator('input[name="credit[]"]').nth(1);
  if (await debitInput.count()) {
    await debitInput.fill('100');
    await page.waitForTimeout(300);
    check(near(await page.locator('#vDebitTotal').textContent(), 100), '传票借方合计实时 = 100');
    check(near(await page.locator('#vDiff').textContent(), 100), '传票差额实时 = 100（不平衡）');
    await creditInput.fill('100');
    await page.waitForTimeout(300);
    check(near(await page.locator('#vCreditTotal').textContent(), 100), '传票贷方合计实时 = 100');
    check(near(await page.locator('#vDiff').textContent(), 0), '借贷平衡后差额实时 = 0');
  } else {
    check(false, '未找到传票借贷输入行');
  }

  check(errors.length === 0, '全程无 JS 错误' + (errors.length ? '：' + errors.join(' ; ') : ''));

  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass} 项 / 失败 ${fail} 项`);
  if (failures.length) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
