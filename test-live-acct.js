/* 线上会计模块 + 云同步页专项验证 */
const { chromium } = require('playwright');
const BASE = 'https://tycompnies.github.io/taiyuan-erp/';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let pass = 0, fail = 0;
  const check = (cond, msg) => { cond ? pass++ : fail++; console.log((cond ? '  PASS: ' : '  FAIL: ') + msg); };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 禁用自动同步（防止测试数据推送/拉取污染生产 erp-sync.json）
  await page.evaluate(() => { if (typeof CloudSync !== 'undefined') CloudSync.DEFAULT_SYNC_CFG = null; });
  await page.fill('[name=username]', 'admin');
  await page.fill('[name=password]', 'admin123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);

  // 会计科目页
  await page.goto(BASE + '#/accounting/accounts');
  await page.waitForTimeout(800);
  const accText = await page.evaluate(() => document.body.innerText);
  check(accText.includes('会计科目'), '线上会计科目页渲染');
  check(accText.includes('银行存款') && accText.includes('应收账款'), '线上科目表种子数据加载');
  check(accText.includes('主营业务收入'), '线上损益类科目存在');

  // 试算表
  await page.goto(BASE + '#/accounting/trial-balance');
  await page.waitForTimeout(800);
  const tbText = await page.evaluate(() => document.body.innerText);
  check(tbText.includes('试算') || tbText.includes('平衡'), '线上试算表页渲染');

  // 资产负债表
  await page.goto(BASE + '#/accounting/balance-sheet');
  await page.waitForTimeout(800);
  const bsText = await page.evaluate(() => document.body.innerText);
  check(bsText.includes('资产负债') || bsText.includes('资产'), '线上资产负债表页渲染');

  // 总分类账
  await page.goto(BASE + '#/accounting/general-ledger');
  await page.waitForTimeout(800);
  const glText = await page.evaluate(() => document.body.innerText);
  check(glText.includes('总分类') || glText.includes('分类账'), '线上总分类账页渲染');

  // 云同步设置页
  await page.goto(BASE + '#/tools/cloud-sync');
  await page.waitForTimeout(800);
  const csText = await page.evaluate(() => document.body.innerText);
  check(csText.includes('云端同步') || csText.includes('同步'), '线上云同步页渲染');
  check(csText.includes('textdb') || csText.includes('GitHub'), '线上云同步双供应商配置界面');

  // CloudSync 引擎加载
  const csOk = await page.evaluate(() => typeof CloudSync !== 'undefined' && !!CloudSync.isConfigured);
  check(csOk, '线上 CloudSync 引擎已加载');

  // ACCT 引擎加载
  const acctOk = await page.evaluate(() => typeof ACCT !== 'undefined' && typeof ACCT.onShipment === 'function');
  check(acctOk, '线上 ACCT 会计引擎已加载');

  // 业务事件自动传票冒烟：模拟一笔出货 → 检查传票自动生成
  const autoV = await page.evaluate(() => {
    // 注入最小测试数据（DB 为顶层 const，直接访问）
    if (!DB.find('items', i => i.id === 'it_live')) {
      DB.insert('items', { id: 'it_live', code: 'LIVETEST', name: '线上验证商品', unit: '个', stock_unit: '个', sales_to_stock: 1, purchase_to_stock: 1, category: '', cost: 10, currency: 'CNY', safe_stock: 0, enabled: true });
    }
    DB.addStock('wh1', 'it_live', 100, 10);
    const cu = DB.list('customers')[0];
    const so = DB.insert('sales_orders', {
      no: 'SOlive001', customer_id: cu.id, customer_name: cu.name, date: '2026-08-20',
      status: 'draft', currency: 'CNY', tax_rate: 0,
      lines: [{ item_id: 'it_live', code: 'LIVETEST', name: '线上验证商品', qty: 2, unit: '个', unit_price: 50, amount: 100 }],
      goods_amount: 100, tax_amount: 0, invoice_amount: 100, taxable_amount: 100
    });
    // 模拟出货
    const shipment = DB.insert('shipments', { no: 'SHlive001', order_id: so.id, date: '2026-08-20', wh: 'wh1', status: 'shipped', lines: so.lines.map(l => ({ ...l })) });
    if (typeof ACCT !== 'undefined' && ACCT.onShipment) ACCT.onShipment(shipment, so);
    DB.update('sales_orders', so.id, { status: 'shipped' });
    const v = DB.list('vouchers').find(x => String(x.biz_key).indexOf('SHIP:' + shipment.id) === 0);
    return v ? { no: v.no, status: v.status, lines: v.lines.length } : null;
  });
  check(!!autoV && autoV.status === '已过账', '线上业务自动传票生成（' + (autoV ? autoV.no + ' ' + autoV.status : '未生成') + '）');

  check(errors.length === 0, '线上无 JS 错误' + (errors.length ? ': ' + errors[0] : ''));
  await browser.close();
  console.log(`\n== 线上专项验证: ${pass} 通过, ${fail} 失败 ==`);
  process.exit(fail ? 1 : 0);
})();
