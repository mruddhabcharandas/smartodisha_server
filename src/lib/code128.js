// Code 128B patterns
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
];

export function getCode128Modules(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";

  // Start with Code 128B start symbol (index 104)
  const codes = [104];
  let checksum = 104;

  for (let i = 0; i < clean.length; i++) {
    const charCode = clean.charCodeAt(i);
    const codeVal = charCode - 32;
    if (codeVal >= 0 && codeVal <= 95) {
      codes.push(codeVal);
      checksum += codeVal * (i + 1);
    }
  }

  // Checksum % 103
  codes.push(checksum % 103);
  // Stop symbol (index 106)
  codes.push(106);

  // Convert to pattern modules
  let modules = "";
  for (const c of codes) {
    const pattern = CODE128_PATTERNS[c];
    if (pattern) {
      let isBar = true;
      for (let j = 0; j < pattern.length; j++) {
        const width = parseInt(pattern[j], 10);
        modules += (isBar ? "1" : "0").repeat(width);
        isBar = !isBar;
      }
    }
  }
  modules += "11";
  return modules;
}

export function generateCode128Svg(text, { height = 65, barWidth = 2, showText = true } = {}) {
  const clean = String(text || "").trim();
  if (!clean) return "";

  const modules = getCode128Modules(clean);
  if (!modules) return "";

  // Render SVG bars

  // Render SVG bars
  const totalWidth = modules.length * barWidth;
  const svgHeight = showText ? height + 18 : height;

  let rects = "";
  let currentX = 0;
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === "1") {
      rects += `<rect x="${currentX}" y="0" width="${barWidth}" height="${height}" fill="#000000" />`;
    }
    currentX += barWidth;
  }

  const textElement = showText
    ? `<text x="${totalWidth / 2}" y="${height + 14}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#000000" letter-spacing="1.5">${clean}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${svgHeight}" style="max-width: 100%; height: auto; display: block; margin: 0 auto;">${rects}${textElement}</svg>`;
}
