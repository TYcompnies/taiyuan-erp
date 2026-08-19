/* rmbUpper 单元测试：从 app.js 提取函数逻辑测试（避免依赖浏览器） */
function rmbUpper(n) {
    const num = Number(n) || 0;
    if (num === 0) return "零元整";
    const neg = num < 0;
    const abs = Math.abs(num);
    const cn = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
    const unit = ["", "拾", "佰", "仟"];
    const big = ["", "万", "亿", "万亿"];
    let s = "";
    const groups = [];
    let x = Math.floor(abs);
    if (x === 0) s = "零";
    while (x > 0) { groups.unshift(x % 10000); x = Math.floor(x / 10000); }
    let needZero = false;
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g === 0) { needZero = true; continue; }
        const str = String(g).padStart(4, "0");
        let gs = "", zf = false;
        for (let i = 0; i < 4; i++) {
            const d = parseInt(str[i], 10);
            if (d === 0) { zf = true; }
            else {
                if (zf && (gs !== "" || s !== "")) gs += "零";
                gs += cn[d] + unit[3 - i];
                zf = false;
            }
        }
        if (needZero) s += "零";
        s += gs + big[groups.length - 1 - gi];
        needZero = false;
    }
    const dec = Math.round((abs - Math.floor(abs)) * 100);
    const jiao = Math.floor(dec / 10), fen = dec % 10;
    let r = s + "元";
    if (jiao === 0 && fen === 0) r += "整";
    else {
        if (jiao > 0) r += cn[jiao] + "角";
        else if (fen > 0) r += "零";
        if (fen > 0) r += cn[fen] + "分";
    }
    return (neg ? "负" : "") + r;
}

const cases = [
    [0, "零元整"],
    [1, "壹元整"],
    [10, "壹拾元整"],
    [1.5, "壹元伍角"],
    [1234.56, "壹仟贰佰叁拾肆元伍角陆分"],
    [1000000, "壹佰万元整"],
    [1002000.3, "壹佰万贰仟元叁角"],
    [1010000, "壹佰零壹万元整"],
    [50000.08, "伍万元零捌分"],
    [100000000, "壹亿元整"],
    [100200030.04, "壹亿零贰拾万零叁拾元零肆分"],
    [0.05, "零元零伍分"],
    [-123.45, "负壹佰贰拾叁元肆角伍分"],
    [999999999999.99, "玖仟玖佰玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分"]
];
let pass = 0, fail = 0;
for (const [input, expected] of cases) {
    const got = rmbUpper(input);
    const ok = got === expected;
    if (ok) pass++; else { fail++; console.log(`FAIL: ${input} → ${got}（期望 ${expected}）`); }
}
console.log(`rmbUpper: ${pass}/${cases.length} 通过${fail ? "，" + fail + " 失败" : ""}`);
process.exit(fail ? 1 : 0);
