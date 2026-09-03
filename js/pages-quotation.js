/* =========================================================
 * 估价试算（外挂嵌入页）
 * 独立部署的外部跨境成本利润试算工具（无品牌名，标题「估價試算」）：
 * - 分页一：跨境进口电商试算——供应商采购 → 出口/进口报关费 → 淘宝/抖音/小红书/盘商平台利润分析（分品项）
 * - 分页二：大陆供应商出口国外客户估价——EXW（出厂价）/ FOB（船上交货）双贸易条件模块
 * - 免登录：开启即用；数值可汇出 EXCEL，亦可复制「同步网址」跨装置/网域带数备份
 * - 本页仅负责在 ERP 框架内以 iframe 嵌入展示，不改动该系统任何逻辑
 * - 若系统网址日后更换，只需修改下方 QUOTATION_URL
 * ========================================================= */

const QUOTATION_URL = "https://93590751eb284b0587ff220bbcdec39b.app.workbuddy.link/";

Pages.quotationPage = function () {
    const html = `
    <div class="bk-embed">
        <div class="bk-toolbar">
            <div class="bk-toolbar-info">
                <strong>商品估价试算（跨境成本利润分析）</strong>
                <span>免登录直接使用 · 进口电商利润试算（采购→报关→淘宝/抖音/小红书/盘商）· 出口 EXW/FOB 估价 · 数据随网址同步备份 · 与 ERP 数据隔离</span>
            </div>
            <div class="bk-toolbar-actions">
                <a class="btn" href="${QUOTATION_URL}" target="_blank" rel="noopener" title="在新窗口独立打开商品估价试算">↗ 新窗口打开</a>
            </div>
        </div>
        <div class="bk-frame-wrap">
            <iframe id="quotationFrame" src="${QUOTATION_URL}" title="商品估价试算"
                referrerpolicy="no-referrer-when-downgrade" allow="clipboard-write"></iframe>
        </div>
    </div>`;
    renderShell("finance.quote", html, "首页 / 进销存账款/财务 / 商品估价试算");
};
